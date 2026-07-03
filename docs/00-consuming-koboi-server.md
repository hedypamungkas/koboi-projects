# Consuming the koboi Server — Reference Contract

> **Status:** Reference (shared by all sector one-pagers in this repo) · **Date:** 2026-07-03
> **Source:** `koboi-agent` repo, branch `feature/sse-server`, code-grounded (file:line citations below).
> **Scope:** This repo is a **consumer** of `koboi-agent` — installed via `pip install koboi-agent[api] @ git+...`,
> never a fork. Every sector one-pager in `docs/` builds on this contract.

Each sector doc only describes what's *different* for that use case (tools/hooks/retriever/guardrails/config).
This doc is the one place that explains *how a client actually talks to koboi*.

---

## 1. Two ways to run an agent turn

| | Interactive chat | Autonomous job |
|---|---|---|
| Endpoint | `POST /v1/chat/stream` | `POST /v1/jobs` |
| Transport | SSE, streamed | SSE tail (`GET /v1/jobs/{id}/stream`) or poll (`GET /v1/jobs/{id}`) |
| Human-in-the-loop | Yes — `pending_approval` events + `POST /v1/sessions/{id}/approve` | No — `AutonomousApprovalHandler` auto-approves inside a **mandatory `sandbox.backend=restricted`** |
| `mode` allowed | `chat/plan/act/auto`, plus `yolo` only if the operator set `allow_yolo=True` server-side | `chat/plan/act/auto` only — **yolo is always rejected**, regardless of server config |
| Use when | A human is present for the turn (support chat, live Q&A) | Fire-and-forget / batch work (nightly reconciliation, bulk classification) |

Both request bodies accept the same two "request-time knobs" (shipped 2026-07-03, G2):

```jsonc
// POST /v1/chat/stream
{ "message": "...", "mode": "act", "max_iterations": 10 }
// POST /v1/jobs
{ "message": "...", "session_id": "optional", "mode": "act", "max_iterations": 10 }
```

- `mode` is validated against `server.allowed_modes` (default `chat,plan,act,auto`) → `400 invalid_mode` if not allowed.
- `max_iterations` is **clamped** (not rejected) to `server.limits.max_iterations_cap` (default 25).
- Job lifecycle: `pending → running → {completed, failed, timed_out, cancelled}`. On server restart, in-flight jobs become `failed` with `error_class=InterruptedByRestart, retriable=true` and pending ones requeue automatically.

## 2. Endpoints

| Method + path | Purpose |
|---|---|
| `GET /healthz` / `GET /readyz` | Liveness / readiness — always open, no auth |
| `POST /v1/sessions` | Create a session (returns `X-Session-Id`) |
| `GET /v1/sessions/{id}` | Fetch message history |
| `DELETE /v1/sessions/{id}` | Evict a session |
| `POST /v1/sessions/{id}/resume` | Rehydrate after crash/redeploy (non-streaming JSON), then continue via `/chat/stream` |
| `POST /v1/chat/stream` | Interactive SSE chat with HITL |
| `POST /v1/sessions/{id}/approve` | Resolve a pending HITL approval |
| `POST /v1/jobs` | Submit an autonomous job (`202`) |
| `GET /v1/jobs` / `GET /v1/jobs/{id}` | List / poll jobs |
| `GET /v1/jobs/{id}/stream` | SSE tail/replay of a job's events |
| `POST /v1/jobs/{id}/cancel` | Cancel a pending/running job |

## 3. SSE event shape

Every frame is `data: {json}\n\n`; the stream always ends with `data: [DONE]\n\n`; idle periods emit
`: keepalive\n\n` every 15s (ignorable per SSE spec). Event `type` values: `text_delta`, `tool_call`,
`tool_result`, `iteration`, `complete`, `error`, `pending_approval`, `routing_decision`, `agent_dispatch`,
`agent_result`, `orchestration_complete`. The `complete` event carries `content`, `elapsed_seconds`,
`iterations_used`, `tools_used`, `token_usage`, `model_name`, `trace_id`. Job streaming reuses the exact
same encoder over a buffered event log (capped at 500 events by default).

## 4. Auth

Bearer token: `Authorization: Bearer koboi_<64 hex>`. Keys are created with the CLI:

```bash
docker compose run --rm koboi koboi keys create --label <sector>-prod
# -> prints the token ONCE; hash is written to keys.json
```

No scopes — a valid key maps to a `key_id` used as the owner/tenant id for job isolation. `server.auth_required`
defaults to `true` and fails closed (401) with no keys configured.

## 5. Extending koboi from a consumer package

Every sector project in this repo is a small installable Python package (`src/<sector>_ext/`) that koboi
imports at agent-build time — **we never fork `koboi-agent` itself.**

| Extension point | Registration | YAML wiring |
|---|---|---|
| Custom tool | `@tool(name=, description=, parameters=, risk_level=)` from `koboi.tools.registry` | `tools.custom: [{module: <pkg>.tools}]` |
| Custom retriever (RAG) | `@register_retriever("name")` from `koboi.rag.registry`, subclass `BaseRetriever` | `rag.retriever: name`, `rag.custom_modules: [<pkg>.rag.my_retriever]` |
| Custom hook (audit/compliance/notify) | `register_hook(HookEntry(name=, config_key=, should_add=, factory=))` at import time — **no YAML `custom_modules` key exists for hooks**; the module must be imported before `KoboiAgent.from_config()` runs (e.g. in your app's entrypoint) | n/a (import-time side effect) |
| Custom guardrail | `GuardrailRegistry.register(name, factory)`, subclass `BaseGuardrail`/`PatternGuardrail` | No YAML `custom_modules` either — register via the `koboi.guardrails` entry-point group in your package's `pyproject.toml`, or import manually before agent construction |
| Approval handler (maker-checker) | Subclass `ApprovalHandler`, override `should_approve(tool_name, arguments, risk_level)` | Wired at `AgentAssembler` build time (imperative path) |

Config-selected components (retriever, context strategy) use **constructor introspection**: whatever keys
you put under `rag:`/`context:` in YAML are matched to the class `__init__` params by name. This is why the
sector configs below look like plain data, not code.

Risk levels for tools: `SAFE` (default) / `MODERATE` / `DESTRUCTIVE` (`koboi.types.RiskLevel`) — destructive
tools are the natural gate for approval workflows in regulated sectors (finance, healthcare, legal).

Useful `HookEvent`s for business logic: `PRE_TOOL_USE` / `POST_TOOL_USE` (audit logging, compliance checks
against tool arguments/results), `PRE_INPUT` (jurisdiction/PII gating before the LLM sees input),
`POST_OUTPUT` (redaction, notify-on-response), `SESSION_END` (final audit flush).

## 6. Deployment shape (mirrors `koboi-agent`'s own `Dockerfile`/`docker-compose.yml`)

- `pip install "koboi-agent[api] @ git+https://.../koboi-agent.git"` — the `[api]` extra pulls in
  `fastapi`+`uvicorn` only; it does **not** include the TUI/CLI-resume extras (`[tui]`) or Langfuse (`[tracing]`).
- Single container, non-root, `/data` volume holds everything that must survive a restart:
  `koboi_memory.db(+.-shm/-wal)` (SQLite WAL — also the journal `steps` table), `keys.json`, per-session
  sandbox workdirs (TTL-GC'd, default 24h).
- `koboi serve config/agent.yaml --host 0.0.0.0 --port 8000`, healthcheck on `/healthz`.
- **Single-node only** — `AgentCore` is not concurrent-safe; the server pool serializes per-session access
  and there is no multi-process/horizontal-scale path yet. Don't promise elastic scaling in a sector pitch.
- Observability: set `tracing.provider: langfuse` in config + `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/
  `LANGFUSE_BASE_URL` env — fully opt-in, fails open (no-op) if unset.

## 7. Known limitations to disclose to a customer

No sync `/chat` (SSE-only). No WebSocket. No webhook delivery — jobs are pull-only (poll or SSE-tail). No
HITL on jobs. No OpenAI-compat adapter. No artifact-retrieval endpoint (files live only in the per-session
workdir). Multi-tenant isolation is interface-ready but not runtime-enforced in v1 — don't pitch this as a
shared-tenant SaaS platform yet; it's a **single-customer, self-hosted** deployment per instance.
