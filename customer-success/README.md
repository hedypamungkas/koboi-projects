# SaaS Customer Success -- Account Health &amp; Renewal

Runnable build for [`docs/10-customer-success-renewal.md`](../docs/10-customer-success-renewal.md).
Read that doc and [`docs/00-consuming-koboi-server.md`](../docs/00-consuming-koboi-server.md) first.

## What this demonstrates

This is the **single-agent use case** in the new set (UC1-3 are orchestrated) -- and that's load-bearing,
because the features below only behave correctly on the single-agent facade path:

- **Proactive long-term memory** -- `memory.proactive` (extract / recall / core-block) remembers each
  account's durable facts (CSM, commitments, sentiment, history) and recalls the top-N each turn, no tool
  call. This is the headline.
- **Self-consistency** -- `self_healing.self_consistency` samples the structured churn-risk answer N times
  and aggregates it (a high-stakes structured decision gets consensus, not a single sample).
- **Human approval (HITL)** -- the `draft_outreach` tool is `MODERATE`, so koboi's `pending_approval` event
  fires and the CSM approves/rejects the outreach draft before it's saved. **This is the one new use case
  with an in-chat approval card** -- orchestration-mode UC1-3 can't surface it (see their READMEs).
- **Multimodal generation** -- `media:` (image, mock provider) can generate a QBR summary image on request.
- **Human handover** -- `flag_at_risk` + `handover.digest` route at-risk accounts to the CSM with a warm
  summary; `grounding_check` keeps the rationale faithful to the fetched signals.
- **Job webhooks** -- the weekly account-review job HMAC-POSTs its result to the CRM (Salesforce/Gainsight
  stand-in).

**Live-verified (2026-07-18, real LLM via the shared gateway):**
- Churn-risk assessment: `fetch_account_health` → `score_churn_risk` (81/high) → a clean structured JSON
  `{account_id, churn_risk_score, risk_level, recommended_action, rationale}` (the schema the prompt
  specifies).
- HITL outreach: `draft_outreach` (MODERATE) → `pending_approval` → resolved via
  `POST /v1/sessions/{id}/approve` (`resolved: true`) → draft saved to `/data/outreach/ACC-7702-*.json`
  (`status: approved-draft-saved`).

`self_consistency` and `media` are wired per config; they were not the focus of this live run (the
structured answer was produced directly; no image was requested). Live-verify them specifically if they're
load-bearing for you.

## Why single-agent (and why that matters)

`self_consistency` runs N samples of the terminal structured answer and aggregates -- that mechanism lives
on the single-agent facade loop. Likewise `pending_approval` (the approval card) only surfaces on the
single-agent path; with `orchestration.enabled`, chat routes through `_run_orchestrator`, which returns a
final `RunResult` and emits no `pending_approval`. So this app deliberately stays single-agent: it's the
one place HITL approval + self-consistency + proactive memory all compose. (UC1-3 chose orchestration and
route human judgment through `transfer_to_human` + `policy.rules` instead.)

## Deliberate deviations / notes

1. **`media` uses the `mock` image provider** so the build runs offline. The `generate_image` tool surfaces
   when `media.enabled` is true; live-verify the exact tool surfacing in your environment if QBR image
   generation is load-bearing. A real provider (e.g. provider-specific image API key) replaces `mock`.
2. **`self_consistency` aggregates the agent's structured terminal answer.** The system prompt instructs a
   single-JSON-object risk assessment (like hr-screening's JSON). Deterministic scoring lives in the
   `score_churn_risk` tool; the *recommended_action* judgment is what gets sampled + voted.
3. **`draft_outreach` is the HITL pause.** It's `MODERATE`; over chat it produces a `pending_approval` card
   resolved via `POST /v1/sessions/{id}/approve`. In the weekly *job* path it can't pause (jobs never do) --
   so the job is scoped to assessment + flagging, not sending drafts.
4. **`server.auth_required: false`** for the local smoke test. Production sets `true` + tokens.

## Layout

```
customer-success/
  pyproject.toml           # installable `cs_ext` package (src/ layout)
  config/agent.yaml        # proactive memory + self_consistency + media + handover + jobs.webhooks
  src/cs_ext/
    tools.py               # fetch_account_health, score_churn_risk, draft_outreach (MODERATE), flag_at_risk
  data/seed/cs_playbook.md # risk-level -> action reference
  backend/Dockerfile       # koboi-agent[api]==0.18.2 + cs_ext; bare `koboi serve`
  frontend/                # accounts panel + CSM chat with approve/reject card, vanilla JS
  docker-compose.yml
```

## Running it

```bash
cd customer-success
docker compose build
docker compose up -d
```

Copy `.env.example` to `.env` and fill in `OPENAI_*` (+ embedding vars; proactive recall needs them).
`.env` is gitignored.

- Backend: `http://localhost:8010`
- Frontend: `http://localhost:3010`

### Smoke test

```bash
curl -sf http://localhost:8010/healthz

# Structured churn-risk assessment (consensus-voted). mode:"act" is required.
curl -s -N -X POST http://localhost:8010/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message": "Score the churn risk for ACC-7702 and recommend an action.", "mode": "act"}'

# Outreach draft -> a pending_approval event for draft_outreach (MODERATE). Grab the
# X-Session-Id and the approval_id, then resolve it:
SID=<session-id-from-header>
curl -s -N -X POST http://localhost:8010/v1/chat/stream -H "Content-Type: application/json" \
  -H "X-Session-Id: $SID" \
  -d '{"message": "Draft an email outreach for ACC-7702 focusing on their usage decline and a QBR offer.", "mode": "act"}'
# then POST /v1/sessions/$SID/approve with the approval_id from the pending_approval event.

# Weekly account-review job:
JOB=$(curl -s -X POST http://localhost:8010/v1/jobs -H "Content-Type: application/json" \
  -d '{"message": "Review all tracked accounts; score churn risk; flag any at-risk accounts for their CSM.", "mode": "act"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')
curl -s "http://localhost:8010/v1/jobs/$JOB"

docker compose exec koboi cat /data/at_risk.log    # flagged accounts
docker compose down
```

If the agent errors or proactive recall isn't surfacing, check `docker compose logs koboi` (recall needs a
working embedding endpoint).

## Frontend

Plain HTML + vanilla JS, no build step. Left panel lists the three demo accounts (mirroring `cs_ext.tools`);
clicking one pre-fills a risk-assessment question. The chat column runs `streamChat()` (doc 00 §3) with
`X-Session-Id` across turns and `mode: "act"`. A `pending_approval` event for `draft_outreach` renders an
inline approve/reject card that posts to `POST /v1/sessions/{id}/approve`. CORS is required (3010 ≠ 8010):
`config/agent.yaml` sets `server.cors.allow_origins: ["http://localhost:3010"]` +
`expose_headers: ["X-Session-Id"]`.
