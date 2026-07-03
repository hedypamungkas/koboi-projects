# Real Estate & Property Management — Buyer Chat + Nightly Listing Automation

One koboi deployment answers buyer questions on the listings site all day, then drafts fresh listing copy
and lead follow-ups every night — no second system to build or run.

> Read [`docs/00-consuming-koboi-server.md`](00-consuming-koboi-server.md) first. This doc only covers what's
> different for real estate. The verified, tested build is [`../real-estate/README.md`](../real-estate/README.md) —
> that's the source of truth if anything here and the running code disagree.

## The scenario

**Harbor Realty Group** manages a few hundred rental and for-sale listings, tracked in a Yardi/AppFolio-style
CRM. Buyers browsing the listings site keep asking the same questions — pet policy, square footage, what's
nearby — that a human has to answer one by one. New listings also sit with bare-bones copy for days because
nobody has time to write it, and leads that haven't been contacted in a week go cold. Harbor wants a chat
widget for the first problem and a nightly batch job for the second, without standing up two systems.

## What you get for free

Both problems are solved by the same koboi deployment — one `config/agent.yaml`, one Docker container. The
only difference is which endpoint calls it:

| | Buyer chat | Nightly automation |
|---|---|---|
| Endpoint / mode | `POST /v1/chat/stream`, `mode: chat` | `POST /v1/jobs`, `mode: act` |
| Triggered by | A visitor on the listings site | A cron job, once a night |
| Reads | Property details from the CRM, floorplans/HOA/neighborhood docs via RAG | New listings and stale leads from the CRM |
| Writes | Nothing | Draft description / draft email — never published or sent |

That's it — no second config, no second deployment. `server.allowed_modes: [chat, act]` is what lets both
paths run against the same server.

The nightly job's fan-out is also free — no custom code. `delegate_tasks` (doc 00 §7) is a built-in tool the
agent calls itself, mid-run, to hand a batch of independent items to parallel sub-agents and get every result
back in one tool result. The system prompt just tells the agent to draft tonight's listings and follow-ups
with it. The cap is 10 items per call, and it's a real constraint worth planning around: 8 new listings plus 6
stale leads is 14 items, so that's two `delegate_tasks` calls in the same job run, not one.

## What you build

Two kinds of tools, split by how risky they are:

- `lookup_property` — **SAFE**. Reads a property's price, availability, and amenities from the CRM. Used by
  buyer chat.
- `draft_listing_description` and `draft_followup_email` — **MODERATE**. Write a draft to the CRM; nothing is
  published or sent. They stay `MODERATE`, not `DESTRUCTIVE`, on purpose: jobs run unattended with no approval
  step (doc 00 §2), so a job can only do things that are safe with nobody watching. Publishing or sending
  needs a human, so these tools go as far as "draft" and stop.

These two are still the only custom tools here. `delegate_tasks` doesn't replace them — it's the built-in
mechanism that calls them, once per listing or lead, across the whole nightly batch in parallel.

```python
# src/realestate_ext/tools.py
from koboi.tools.registry import tool
from koboi.types import RiskLevel

@tool(
    name="lookup_property",
    description="Look up a property's price, availability, and amenities by listing ID or address.",
    parameters={
        "type": "object",
        "properties": {"listing_id": {"type": "string"}, "address": {"type": "string"}},
        "required": [],
    },
    risk_level=RiskLevel.SAFE,
)
async def lookup_property(listing_id: str = "", address: str = "") -> str:
    # call the CRM's read API, return a short summary
    ...

@tool(
    name="draft_listing_description",
    description=(
        "Write a listing description into the CRM's draft field from raw property data. "
        "Does not publish — a human agent reviews and publishes separately."
    ),
    parameters={
        "type": "object",
        "properties": {"listing_id": {"type": "string"}, "raw_data": {"type": "object"}},
        "required": ["listing_id", "raw_data"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def draft_listing_description(listing_id: str, raw_data: dict) -> str:
    # writes to the CRM's draft field only, never flips the listing to "published"
    ...

# draft_followup_email follows the same shape: takes lead_id + context, writes a
# draft to the CRM's pending-send queue, and never calls a send/SMTP API itself.
```

## Architecture

```
  Buyer's browser                    External cron (nightly)
       │ POST /v1/chat/stream               │ POST /v1/jobs (mode: act)
       ▼                                     ▼
┌───────────────────────────────────────────────────────┐
│              koboi server (Docker) — one config           │
│  RAG (floorplans,   lookup_property     delegate_tasks     │
│  HOA, neighborhood)  (SAFE)             (≤10 items/call) │
│                                          │           │      │
│                                          ▼           ▼      │
│                          draft_listing_description       │
│                          draft_followup_email (MODERATE,  │
│                          many in parallel, one per item)  │
└───────────────────────────┬─────────────────────────────┘
                             ▼
              CRM (Yardi/AppFolio/HubSpot-style)
       reads property/lead data — writes drafts only
                             │
                             ▼
              human agent reviews, publishes/sends
```

Buyer chat only reads — it answers from the RAG corpus and looks up live data, never writes anything. The
nightly job is the only path that writes, and it only ever writes a draft. Within that one job turn, the
fan-out to individual drafts happens via `delegate_tasks`, not one draft per job.

## The frontend

Two surfaces, one backend:

- **Listing-page chat widget** — a chat bubble on every property page, pre-loaded with that listing's ID so
  buyers don't have to repeat which unit they mean. Built on doc 00 §3's `streamChat`.
- **Agent dashboard** — an internal page listing last night's batch of drafts, with a "publish" / "send"
  button per row. Clicking it calls the CRM's own API, not koboi — koboi never publishes or sends anything.

```js
// listing-widget.js — buyer chat, scoped to one listing (listingId comes from the page template)
document.getElementById("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("chat-input");
  const message = `[listing:${listingId}] ${input.value}`;
  input.value = "";
  const bubble = appendBubble("assistant", "");
  await streamChat(message, (event) => {
    if (event.type === "text_delta") bubble.textContent += event.text;
    if (event.type === "tool_call") showTypingHint("checking property details...");
    if (event.type === "error") bubble.textContent = "Sorry, something went wrong — try again shortly.";
  });
});
```

## Docker

```yaml
# docker-compose.yml
services:
  koboi:
    build: ./backend              # koboi-agent[api] + realestate_ext, pip install -e .
    ports: ["8000:8000"]
    volumes: ["koboi-data:/data"] # memory db, keys, session workdirs
    env_file: .env
  web:
    build: ./frontend             # listing widget + agent dashboard, static build
    ports: ["3000:80"]
    depends_on: [koboi]
volumes:
  koboi-data:
```

`backend/Dockerfile` installs `koboi-agent[api]` and `realestate_ext`, then runs `koboi serve
config/agent.yaml --host 0.0.0.0 --port 8000`. The nightly cron is outside this compose file — any scheduler
Harbor already uses — and just calls `POST /v1/jobs` once per property batch and once per stale-lead batch.

## config/agent.yaml

```yaml
agent:
  mode: act                    # ModeHook hard-blocks every custom tool — even SAFE lookup_property — in
                                # chat/plan mode; act is the config default both buyer chat and the nightly
                                # job actually run under, since neither sends a per-request mode (doc 00 §2)

tools:
  builtin: [delegate_tasks]    # tools.builtin is a hard gate, not a default-on allowlist — empty/unset
                                # disables every builtin, delegate_tasks included (doc 00 §7)
  custom:
    - module: realestate_ext.tools

rag:
  retriever: hybrid            # floorplans, HOA rules, neighborhood guides
  chunking: paragraph
  top_k: 8
  corpus_path: data/seed/

sandbox:
  backend: restricted          # jobs refuse to start at all on the default passthrough (doc 00 §9)

jobs:
  max_concurrent: 4            # concurrent JOBS (e.g. property batch + lead batch), not items within a job —
                                # delegate_tasks handles fan-out inside a single job's turn

server:
  auth_required: true
  allowed_modes: [chat, act]   # buyer widget uses chat; nightly cron uses act
  cors:
    allow_origins: ["*"]       # scope this down to the listings site's real origin in production
  limits:
    max_iterations_cap: 15
```

## Why it matters

Harbor gets a working buyer-chat assistant and a nightly drafting job from one deployment, not two separate
systems — the built-in chat/job split in koboi covers both out of the box. The only code Harbor writes is a
handful of tools that talk to their CRM; streaming, RAG, retries, and the safe-vs-draft distinction all come
from koboi itself. That's the pattern this whole repo makes the case for: start with what's built in, extend
it with a small amount of your own code, and one deployment ends up doing more than it looks like it should.

## Open questions

- **CRM API shape**: this assumes a REST API for reading properties/leads and writing drafts. The real auth
  model and rate limits depend on which CRM Harbor uses, and aren't covered by doc 00.
- **Where humans review drafts**: inside the CRM's own draft view, or a dashboard this project builds itself.
  Doc 00 doesn't define an artifact-review surface, so this is a product decision, not a koboi feature.
- **Batch size vs. job concurrency**: these are two different knobs. `jobs.max_concurrent` caps how many
  separate *jobs* run at once (e.g. the property batch and the lead batch overlapping) — it says nothing
  about how many listings or leads one job processes. Within a single job, `delegate_tasks` fans that batch
  out itself, 10 items per call. Doc 00 still flags `AgentCore` as not concurrent-safe past a handful of
  parallel jobs, so `jobs.max_concurrent` should stay low regardless of how big any one job's batch is.
- **`draft_listing_description`/`draft_followup_email` are reachable from buyer chat, not just the nightly
  job** — nothing in this design scopes the two `MODERATE` drafting tools to job mode only; they're
  registered the same way for both transports, and the system prompt's "don't call these for a batch
  yourself" instruction is guidance, not an enforced gate. Per doc 00 §5, `MODERATE` tools pause for human
  approval (`pending_approval`) over the chat transport — so if a buyer's chat session ever gets the model to
  call one of these directly, that session hits an approval prompt with no approver in a buyer-facing UI, and
  the widget has no handling for that event at all. The real build's e2e test only ever drove these two tools
  through the job path, so this was never exercised. Not fixed here — either the buyer chat widget should
  avoid exposing these tools (a scoping mechanism doc 00 doesn't define per-transport), or the frontend needs
  to handle an unexpected `pending_approval` gracefully instead of hanging.
