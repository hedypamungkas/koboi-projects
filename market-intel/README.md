# Corporate Strategy -- Cited Competitive-Intelligence Briefings

Runnable build for [`docs/08-market-intelligence-briefing.md`](../docs/08-market-intelligence-briefing.md)
(Northwind Strategy, fictional). Read that doc and [`docs/00-consuming-koboi-server.md`](../docs/00-consuming-koboi-server.md) first.

## What this demonstrates

The **first use case built on koboi 0.18's deep-research engine** -- none of the prior apps do live web
research. Notably, **this app is config-only: there is no custom Python package** -- the engine does all
the work (a deliberate "sometimes the built-in is the whole story" data point for this repo's thesis).

- **Deep-research orchestration** -- `orchestration.execution.mode: deep_research` plans a workflow per
  query (plan → search → fetch → assess coverage → drill deeper → synthesize).
- **Web search/fetch** -- `websearch:` selects a provider (Brave/Firecrawl/httpx); `mock` default runs
  offline. Set `WEB_SEARCH_PROVIDER=firecrawl` + `FIRECRAWL_API_KEY` for live research.
- **Cited, coverage-gated synthesis** -- `research:` controls depth, fetch caps, coverage threshold, and
  numbered citations.
- **Hallucination resistance** -- with no sources found, the engine **says so and cites its lack of
  results** rather than inventing facts (verified live).
- **Human handover** -- low coverage hands the half-finished brief to a human analyst.
- **Scheduled brief + webhook** -- the "Run weekly brief" button submits an autonomous job;
  `jobs.webhooks` HMAC-signs the result to the wiki/Slack receiver.

**Live-verified (2026-07-18):**
- `mock` provider: full plan→search→coverage→synthesize pipeline completed; the brief honestly reported
  "no public results found" with numbered citations (the engine refused to fabricate).
- `firecrawl` (live): 31 searches + 32 fetches, 5 sources gathered -- real research. Deep research is
  inherently slow (several minutes for a full brief); the per-job timeout is 1800s.

## Why no custom tools / no `src/` package

An earlier draft added `get_tracked_competitors` / `publish_brief` tools. A live run showed the
deep_research engine **only injects its own `web_search`/`web_fetch` into research nodes** -- top-level
`tools.custom` are registered but never invoked by the engine. So they were dead code, and were removed.
The watchlist now lives in the system prompt; the brief lands as the job result (delivered via
`jobs.webhooks`). Clean and honest.

## Why there is no approval card

`orchestration.enabled` routes chat **and** jobs through the orchestrator, which returns a synthesized
result and emits no `pending_approval`. A research brief has no in-flow money action, so this is a
non-issue; human involvement is the low-coverage `handover`.

## Deliberate deviations / notes

1. **`websearch` defaults to `mock`** so the build runs offline. The mock provider returns scripted/empty
   results, which still exercises the full plan→search→fetch→synthesize→cite loop (and demonstrates the
   hallucination guard). Flip to `firecrawl`/`brave` + a key in `.env` for live research (slow).
2. **Deep research is slow.** A full cited brief fans out many sequential LLM calls; expect several
   minutes (the job timeout is 1800s). The chat smoke test may need a generous `--max-time`.
3. **`server.auth_required: false`** for the local smoke test. Production sets `true` + tokens.

## Layout

```
market-intel/
  config/agent.yaml        # deep_research orchestration + websearch + research + self_healing + handover + jobs.webhooks (NO src/)
  data/seed/tracked_competitors.md   # watchlist + focus areas + brief format
  backend/Dockerfile       # koboi-agent[api]==0.18.2 + config + data only (no package to install)
  frontend/                # watchlist + chat + "Run weekly brief" job button, vanilla JS
  docker-compose.yml
```

## Running it

```bash
cd market-intel
cp .env.example .env   # fill in OPENAI_*; optionally WEB_SEARCH_PROVIDER=firecrawl + FIRECRAWL_API_KEY
docker compose build
docker compose up -d
```

- Backend: `http://localhost:8008` &middot; Frontend: `http://localhost:3008`

### Smoke test

```bash
curl -sf http://localhost:8008/healthz

# Cited deep-research brief (mock provider, offline). Give it time.
curl -s -N --max-time 300 -X POST http://localhost:8008/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message":"Research Acme Cloud pricing and product launches this quarter with citations.","mode":"act"}'

# Autonomous weekly brief job:
JOB=$(curl -s -X POST http://localhost:8008/v1/jobs -H "Content-Type: application/json" \
  -d '{"message":"Run this week'\''s competitive brief across all tracked competitors; cite every claim.","mode":"act"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')
curl -s -N "http://localhost:8008/v1/jobs/$JOB/stream"
```

## Frontend

Plain HTML + vanilla JS, no build step. Left panel is the watchlist (clicking a chip pre-fills a research
question); the chat runs `streamChat()` (doc 00 §3) with `X-Session-Id` + `mode: "act"`. The **Run weekly
brief** button submits `POST /v1/jobs` and tails `/v1/jobs/{id}/stream`. CORS required (3008 ≠ 8008).
