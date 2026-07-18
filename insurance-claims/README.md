# Insurance Ops -- P&amp;C Claims Triage

Runnable build for [`docs/07-insurance-claims-triage.md`](../docs/07-insurance-claims-triage.md)
(Beacon Mutual, a fictional P&amp;C carrier). Read that doc and
[`docs/00-consuming-koboi-server.md`](../docs/00-consuming-koboi-server.md) first.

## What this demonstrates

A single-agent FNOL triage that **never pays a claim** -- it classifies, checks coverage, estimates
damage, screens fraud, and routes. Built on koboi 0.18 features none of the six prior apps exercise:

- **Self-healing** -- `self_healing` retries on tool errors and `tool_verification` (P4 CRITIC) re-checks
  the damage-estimate arithmetic via the built-in `calculate` tool.
- **Human handover** -- `handover.detection` + `handover.digest` produce a warm hand-off when the agent
  routes a claim to an adjuster via the built-in `transfer_to_human`.
- **Policy rules** -- `policy.rules` hard-denies auto-recommending a settlement for a total loss (the
  control gate; no approval surface needed).
- **Job webhooks** -- `jobs.webhooks` HMAC-signs a terminal-status callback to the core claims system.

**Live-verified (2026-07-18, real LLM via the shared gateway):**
- CLM-501 (minor collision): `lookup_claim` → `screen_fraud` (low) → `estimate_repair_cost` ($1,242) →
  `record_recommendation` recorded to `/data/recommendations.jsonl`; cited collision coverage.
- CLM-502 (total loss): estimate returns "total-loss band" + medium fraud → `transfer_to_human`
  (no recommendation recorded).

## Why single-agent, not a DAG

The design doc originally sketched a multi-agent DAG (coverage_check / damage_estimate / fraud_screen /
decide). **In koboi 0.18.2 that does not work as written** -- verified by reading source AND by a live run:

> The orchestrator's local sub-agent builder (`koboi/orchestration/orchestrator.py:478` →
> `AgentFactory.create_agent`) only knows four **hardcoded demo agents** (`hr`/`sales`/`finance`/`general`)
> and falls back to `general` for any other name. The config-aware builder (`factory.py:_build_agent_from_def`)
> is **defined but has zero callers** -- dead code. So `orchestration.agents[].system_prompt` / `rag` /
> `tools` are ignored at runtime; every DAG node runs as the generic `general` agent with **no tools and
> no per-node RAG**. A live DAG run confirmed it: nodes stated intent ("I'll look up CLM-501") but emitted
  `tool_calls: null`.

Rather than ship a headline that doesn't work, this app runs the full triage as ONE agent on the
single-agent facade path, where the custom tools, RAG, self-healing, handover, and policy gates all
genuinely fire (verified above). Orchestration is still showcased in this repo -- by `market-intel`'s
`deep_research` mode, which injects web tools into its research nodes via a separate code path.

## Why there is no settlement approval card

The agent never moves money, so there's nothing to approve mid-flow. `record_recommendation` is `SAFE`
(it queues a suggestion in the adjuster review queue, not a payment). Human judgment enters via
`transfer_to_human` (high-value / coverage-questionable / fraud-flagged claims). HITL approval lives in
`customer-success` (UC10), the use case built for it.

## Deliberate deviations / notes

1. **No `grounding_check` here, on purpose.** This triage is tool-driven -- the load-bearing facts (claim
   record, repair estimate, fraud screen) come from tool *results*, not retrieved RAG chunks.
   `grounding_check` judges faithfulness to retrieved context, so a correct tool-sourced answer scored
   ~0.08 and abstained ("I don't have enough grounded information"), which both misfired and triggered a
   self-healing retry loop (confirmed in a live run). The policy RAG is still retrieved for coverage
   reasoning; it's just not scored by a grounding guardrail. `grounding_check` fits RAG-Q&amp;A apps
   (see `customer-success`), not this.
2. **`policy.rules` is config-only here (the CLM-502 run routed to `transfer_to_human` on its own, so the
   deny-gate wasn't hit).** It's wired per `PolicyRuleConfig` (`argument_patterns` per-arg globs) and is
   evaluated in the tool pipeline; a claim whose `record_recommendation` rationale contains "total loss"
   would be hard-denied. Live-verify if the deny-gate is load-bearing for you.
3. **`server.auth_required: false`** for the local smoke test. Production sets `true` + tokens.
4. **Mock claim store** -- four fictional FNOL records in `claims_ext/tools.py`; no real claims system.

## Layout

```
insurance-claims/
  pyproject.toml           # installable `claims_ext` package (src/ layout)
  config/agent.yaml        # single-agent: tools + RAG + self_healing + handover + policy + jobs.webhooks
  src/claims_ext/
    tools.py               # lookup_claim, estimate_repair_cost, screen_fraud, record_recommendation
  data/seed/
    auto_policy.md         # coverage RAG (policy excerpt)
    fraud_indicators.md    # fraud RAG (SIU protocol)
  backend/Dockerfile       # koboi-agent[api]==0.18.2 + claims_ext; bare `koboi serve`
  frontend/                # adjuster console: FNOL queue + chat, vanilla JS
  docker-compose.yml
```

## Running it

```bash
cd insurance-claims
cp .env.example .env   # then fill in OPENAI_* + EMBEDDING_*
docker compose build
docker compose up -d
```

- Backend: `http://localhost:8007` &middot; Frontend: `http://localhost:3007`

### Smoke test

```bash
curl -sf http://localhost:8007/healthz

curl -s -N -X POST http://localhost:8007/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message":"Triage claim CLM-501 and route it.","mode":"act"}'   # -> record_recommendation

curl -s -N -X POST http://localhost:8007/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message":"Triage claim CLM-502 and route it.","mode":"act"}'   # -> transfer_to_human

docker compose exec koboi cat /data/recommendations.jsonl
```

## Frontend

Plain HTML + vanilla JS, no build step. Left panel lists the four demo FNOL claims; clicking one
pre-fills a triage question. The chat column runs `streamChat()` (doc 00 §3) carrying `X-Session-Id`
across turns and pinning `mode: "act"`. CORS is required (3007 ≠ 8007): `config/agent.yaml` sets
`server.cors.allow_origins: ["http://localhost:3007"]` + `expose_headers: ["X-Session-Id"]`.
