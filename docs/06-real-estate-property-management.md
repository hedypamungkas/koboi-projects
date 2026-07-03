# Real Estate & Property Management — Buyer Inquiry Chat + Nightly Listing/Lead Automation

> **Status:** Design one-pager (not yet built) · **Date:** 2026-07-03
> **Reference:** [`docs/00-consuming-koboi-server.md`](00-consuming-koboi-server.md) — read first for endpoints,
> auth, chat-vs-job modes, SSE shape, and extension points. This doc only covers what's specific to this sector.

## Business problem

A property management/brokerage company wants two things from the same AI investment: (a) a live chat
assistant on their listings site that answers buyer/renter questions about specific properties, and (b) a
nightly automation that drafts fresh listing descriptions from raw property data and follows up with stale
leads in the CRM. This sector is chosen specifically to show that **one koboi deployment, one config file,
can serve both an interactive workload and a scheduled autonomous workload side by side** — the interactive
path uses `POST /v1/chat/stream`, the batch path uses `POST /v1/jobs`, and both hit the same tools/RAG corpus.

## 1. Context & assumptions

| | |
|---|---|
| Customer | Brokerage/property manager with a CRM (Yardi/AppFolio/HubSpot-style system) as system of record for listings and leads, reachable via API |
| What's dynamic (fetched live) | Property details, pricing, availability, lead records — pulled from the CRM API at tool-call time. koboi holds no listing/lead data itself. |
| What's static (RAG corpus) | Floorplans, HOA rules, neighborhood info, amenities descriptions — ingested as documents, retrieved via RAG for buyer Q&A. |
| Execution mode 1 — buyer chat | Interactive, `POST /v1/chat/stream`. A prospective buyer/renter is present for the whole turn; human is available if the bot can't answer (widget-layer handoff, not a koboi feature — see open questions). |
| Execution mode 2 — nightly batch | Autonomous, `POST /v1/jobs` with `mode: act`, one job per property (listing drafts) or per lead batch (follow-ups), triggered by an external cron. No human is present — per doc 00 §1, jobs have no HITL, which is why every write-capable tool in this sector stops at "draft" (see §5). |
| `mode` | `chat`/`act` for the buyer widget, `act` for jobs — both covered by a single `server.allowed_modes: [chat, act]` (see §4 config) |
| Session lifetime | Chat: one session per widget visit, ends when the visitor leaves. Jobs: one job per property/lead-batch run, no session carried over between nightly runs (each job gets its own `session_id`, or none, per doc 00 §1). |

## 2. Architecture

```
  BUYER CHAT (interactive)                    NIGHTLY BATCH (autonomous)
┌──────────────────────┐                    ┌──────────────────────┐
│ Listings site widget   │                    │ External cron          │
└───────────┬───────────┘                    └───────────┬───────────┘
            │ POST /v1/chat/stream (SSE)                  │ POST /v1/jobs (mode: act,
            ▼                                             │   one job per property / lead batch)
┌──────────────────────────────────────────────────────────┴────────┐
│                    koboi server (1 node) — config/agent.yaml         │
└───┬─────────────────────┬──────────────┬─────────────┬────────────┘
    ▼                     ▼              ▼             ▼
┌─────────────┐  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
│ RAG retriever │  │ lookup_       │ │ fetch_new_    │ │ find_stale_leads   │
│ (floorplans,  │  │ property      │ │ listings +    │ │ + draft_followup_  │
│ HOA, neighbor-│  │ (SAFE)        │ │ draft_listing_│ │ email              │
│ hood docs)    │  │               │ │ description   │ │ (SAFE / MODERATE)  │
└─────────────┘  └──────┬───────┘ │ (SAFE / MOD.) │ └─────────┬──────────┘
                          │         └──────┬───────┘           │
                          ▼                ▼                    ▼
                 ┌───────────────────────────────────────────────────┐
                 │        CRM API (Yardi/AppFolio/HubSpot-style)        │
                 │  reads: property/lead data — writes: draft fields    │
                 │  only (human agent reviews & publishes/sends)         │
                 └───────────────────────────────────────────────────┘
```

Both entry paths terminate in the same CRM API and the same `config/agent.yaml` — the only difference is the
endpoint the client calls and the `mode` it requests. In practice `lookup_property` is what buyer chat needs
and `fetch_new_listings`/`draft_listing_description`/`find_stale_leads`/`draft_followup_email` are what the
nightly job needs, though nothing in the config makes them exclusive to one path.

## 3. Project structure

```
realestate-agent/
├── pyproject.toml
├── config/
│   └── agent.yaml           # one config: server.allowed_modes: [chat, act]
├── src/
│   └── realestate_ext/
│       ├── __init__.py
│       └── tools.py         # lookup_property, fetch_new_listings, draft_listing_description,
│                             # find_stale_leads, draft_followup_email
├── data/
│   └── seed/                 # floorplans.md, hoa_rules.md, neighborhood_guides/*.md — the RAG corpus
├── Dockerfile
└── tests/
    └── test_tools.py
```

`pyproject.toml` declares `koboi-agent[api] @ git+https://.../koboi-agent.git` as a dependency and installs
`realestate_ext` as an editable package (`pip install -e .`) so `tools.custom: [{module: realestate_ext.tools}]`
in the YAML can import it — the exact registration contract from doc 00 §5, no koboi core code touched.

## 4. Key code skeletons

### (a) Safe read-only tool for buyer chat

```python
# src/realestate_ext/tools.py
from koboi.tools.registry import tool
from koboi.types import RiskLevel

@tool(
    name="lookup_property",
    description="Look up a property's price, availability, unit details, and amenities by listing ID or address.",
    parameters={
        "type": "object",
        "properties": {
            "listing_id": {"type": "string", "description": "CRM listing ID, e.g. LST-4821"},
            "address": {"type": "string", "description": "Fallback lookup key if listing_id unknown"},
        },
        "required": [],
    },
    risk_level=RiskLevel.SAFE,
)
async def lookup_property(listing_id: str = "", address: str = "") -> str:
    # call the CRM (Yardi/AppFolio/HubSpot) read API, return a compact JSON-as-string summary
    ...
```

### (b) Nightly batch tools — draft only, never publish/send

```python
@tool(
    name="fetch_new_listings",
    description="Fetch properties added or updated in the CRM since the last nightly run.",
    parameters={
        "type": "object",
        "properties": {
            "since": {"type": "string", "description": "ISO 8601 timestamp of last run"},
        },
        "required": ["since"],
    },
    risk_level=RiskLevel.SAFE,
)
async def fetch_new_listings(since: str) -> str:
    ...

@tool(
    name="draft_listing_description",
    description=(
        "Generate a listing description from raw property data and write it to the CRM's "
        "draft-description field. Does NOT publish the listing — a human agent must review "
        "and publish separately."
    ),
    parameters={
        "type": "object",
        "properties": {
            "listing_id": {"type": "string"},
            "raw_data": {"type": "object", "description": "Beds/baths/sqft/amenities/etc from the CRM"},
        },
        "required": ["listing_id", "raw_data"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def draft_listing_description(listing_id: str, raw_data: dict) -> str:
    # writes to a draft field only — never flips the listing to "published"
    ...

@tool(
    name="find_stale_leads",
    description="Find CRM leads with no agent contact in N days.",
    parameters={
        "type": "object",
        "properties": {
            "stale_after_days": {"type": "integer", "default": 7},
        },
        "required": [],
    },
    risk_level=RiskLevel.SAFE,
)
async def find_stale_leads(stale_after_days: int = 7) -> str:
    ...

@tool(
    name="draft_followup_email",
    description=(
        "Draft a personalized follow-up email for a stale lead and save it to the CRM as a "
        "pending draft. Does NOT send the email — a human agent must review and send."
    ),
    parameters={
        "type": "object",
        "properties": {
            "lead_id": {"type": "string"},
            "context": {"type": "string", "description": "Last interaction summary / property of interest"},
        },
        "required": ["lead_id"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def draft_followup_email(lead_id: str, context: str = "") -> str:
    # writes a draft to the CRM's outbox/pending-send queue only — never calls a send/SMTP API
    ...
```

### (c) `config/agent.yaml` (relevant excerpts)

```yaml
mode: chat

tools:
  builtin: [memory]
  custom:
    - module: realestate_ext.tools

rag:
  retriever: hybrid            # koboi builtin; buyer-chat corpus is floorplans/HOA/neighborhood docs
  chunking: paragraph
  top_k: 8
  corpus_path: data/seed/

jobs:
  max_concurrent: 4             # nightly batch size — see §6 caveat on scaling past ~6

server:
  auth_required: true
  allowed_modes: [chat, act]    # buyer widget uses chat/act; nightly cron uses act only
  limits:
    max_iterations_cap: 15
```

One config serves both paths: the buyer widget calls `/v1/chat/stream` with `mode: chat` (or `act` if it needs
`lookup_property` mid-conversation), and the nightly cron calls `/v1/jobs` with `mode: act`. `server.
allowed_modes` covers both without needing two deployments or two configs.

## 5. Draft-not-send design

Every write-capable tool in this sector — `draft_listing_description`, `draft_followup_email` — stops at
**draft** (`RiskLevel.MODERATE`) rather than **publish/send** (which would be `RiskLevel.DESTRUCTIVE` and, per
doc 00 §1/§5, koboi's natural gate for a HITL approval flow). This is a deliberate consequence of running the
nightly automation as a **job**, not a chat session:

- Per doc 00 §1, `/v1/jobs` has **no HITL** — there is no `pending_approval`/`approve` handshake available in
  job mode, unlike `/v1/chat/stream`. Anything that needs a human sign-off before it takes effect (publishing a
  listing publicly, emailing a prospective tenant) cannot safely run inside an unattended job.
- Keeping `draft_listing_description` and `draft_followup_email` at `MODERATE` means they execute immediately
  and write only to a draft/pending field in the CRM — never to a live, customer-facing surface. A human agent
  reviewing their CRM queue the next morning decides what actually goes out.
- If this sector ever wanted the nightly job to publish or send directly, that action would need to be
  `RiskLevel.DESTRUCTIVE`, and per doc 00 §1 the job's `AutonomousApprovalHandler` auto-approves everything
  inside a mandatory `sandbox.backend=restricted` — i.e. "auto-approved" is the *only* outcome available for a
  destructive tool in job mode, with no real human check. That's an unacceptable trade for anything
  customer-facing, so this design intentionally keeps the nightly job's ceiling at "draft," trading a fully
  autonomous publish/send pipeline for one that still saves the team hours of manual drafting while remaining
  safe to run unattended every night.

## 6. Deployment

One self-hosted node, exactly as in doc 00 §6: `pip install "koboi-agent[api] @ git+..."`, `koboi serve
config/agent.yaml --host 0.0.0.0 --port 8000`, `/data` volume for `koboi_memory.db*` + `keys.json` + session
workdirs. The nightly cron (external to koboi — e.g. a system cron job or CI scheduler) issues one
`POST /v1/jobs` per property (for listing drafts) or per lead batch (for follow-ups), then polls
`GET /v1/jobs/{id}` or tails `GET /v1/jobs/{id}/stream` for completion.

`jobs.max_concurrent` should be sized to the nightly batch — e.g. `4` for a portfolio that produces a few dozen
new listings/stale leads per night. Per doc 00 §6, `AgentCore` is not concurrent-safe and there is no
multi-process/horizontal-scale path yet; doc 00 flags concurrency past roughly 6 jobs as an open scaling
question upstream in koboi itself, not something this sector's config can tune around. A portfolio large enough
to need higher job concurrency than that should stagger the cron trigger (e.g. batch properties into multiple
smaller cron windows) rather than raising `max_concurrent` past that point.

## 7. What this demonstrates

This sector is the clearest illustration of a **single koboi deployment serving two different execution
models** from one config: `/v1/chat/stream` for a live, human-present buyer conversation, and `/v1/jobs` for
scheduled, unattended batch work — both backed by the same tools, same RAG corpus, same CRM integration. It
also shows `RiskLevel.MODERATE` (not `DESTRUCTIVE`) as the deliberate ceiling for automation that must run
safely with no human in the loop, versus reserving `DESTRUCTIVE` + approval for anything that would otherwise
need one.

## 8. Open questions

- **CRM API shape**: this doc assumes a Yardi/AppFolio/HubSpot-style REST API exists for both listing reads/
  writes and lead records. Doc 00 says nothing about CRM integrations specifically — the actual auth model,
  rate limits, and draft-field semantics of the customer's real CRM need to be confirmed before `tools.py` can
  be implemented for real.
- **Human review workflow for drafts**: where does a human agent see and act on `draft_listing_description`/
  `draft_followup_email` output — inside the CRM's own UI (if it supports a "draft" state), or does this
  project need a small review dashboard of its own? Doc 00 has no notion of an artifact-review surface (see
  its §7 "no artifact-retrieval endpoint" limitation).
- **Nightly job sizing and scheduling**: how many properties/leads does a typical customer have, and does that
  push `jobs.max_concurrent` toward the ~6-job scaling ceiling doc 00 flags? If so, the batching/staggering
  strategy in §6 needs to be finalized before launch, not left as a runtime tuning knob.
- **Buyer-chat-to-human handoff**: like the e-commerce sector doc, doc 00 has no "hand this session to a live
  agent" concept. Is that purely a widget-layer feature (outside koboi), or does it need a custom tool/hook
  that flags a session for takeover?
- **Job failure/retry semantics for nightly runs**: doc 00 §1 notes jobs interrupted by a server restart become
  `failed` with `retriable=true` and pending jobs requeue automatically — but does the nightly cron need its
  own retry/backoff logic on top of that, or is requeue-on-restart sufficient for a once-nightly batch?
