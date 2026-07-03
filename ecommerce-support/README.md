# Anvil & Co -- E-commerce Support Agent

A runnable demo of `koboi-agent` consumed as an installed package: a storefront chat widget
backed by a koboi server, extended with three small Anvil-specific tools. See
[`docs/01-ecommerce-retail-support.md`](../docs/01-ecommerce-retail-support.md) for the design
doc this app implements, and [`docs/00-consuming-koboi-server.md`](../docs/00-consuming-koboi-server.md)
for the shared API contract (auth, streaming, jobs vs. chat).

## What's here

```
ecommerce-support/
  pyproject.toml            # ecommerce_ext installable package
  config/agent.yaml         # koboi config: RAG, guardrails, tools, server
  src/ecommerce_ext/
    tools.py                # lookup_order, check_return_eligibility, initiate_refund
  data/seed/                # return policy + shipping FAQ (RAG corpus)
  backend/Dockerfile        # koboi-agent[api] + ecommerce_ext, `koboi serve`
  frontend/                 # storefront chat widget + internal approval panel (nginx, static)
  docker-compose.yml
```

## What's built in vs. what's custom

- **Built in, zero code**: RAG over the two seed docs, chat memory, input-injection guardrail,
  rate limiting, the human-approval pause on `DESTRUCTIVE` tools, sandboxed tool execution.
- **Custom** (`src/ecommerce_ext/tools.py`): three tools against a small in-memory mock order
  store (no real Shopify/OMS integration -- this is a demo). `lookup_order` and
  `check_return_eligibility` are `RiskLevel.SAFE`; `initiate_refund` is `RiskLevel.DESTRUCTIVE`,
  so koboi automatically pauses it for human approval before the confirmation is returned.

Mock orders (see `tools.py` for the full dict): `10234`, `10088`, `10301`, `10450` -- a mix of
shipped/delivered/processing and inside/outside the 30-day return window, so both branches of
`check_return_eligibility` are exercised.

## Running it

```bash
cd ecommerce-support
docker compose build
docker compose up -d
curl -sf http://localhost:8001/healthz
curl -sf http://localhost:8001/readyz
```

Then open `http://localhost:3001` for the chat widget, or hit the API directly:

```bash
curl -s -N -X POST http://localhost:8001/v1/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "Where is my order #10234 and can I return it?"}'
```

Bring it down with `docker compose down`.

### Where the OpenAI credentials come from

`docker-compose.yml`'s `koboi` service points `env_file` at the sibling `koboi-agent` repo's
`.env` (absolute path), which already has `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL`
populated for this workstation. If you're running this outside that environment, copy
`.env.example` to `.env` in this directory, fill it in, and change `env_file` in
`docker-compose.yml` to point at it instead.

## Deviations from the spec docs (and why)

- **Tool signatures**: `docs/01`'s illustrative tool snippets use `amount_cents: int` and an
  optional `customer_email` fallback on `lookup_order`. The actual task spec for this build
  (which takes precedence) asked for `amount: float` and `order_id`-only lookup -- implemented
  as specified. `check_return_eligibility` also dropped `line_item_id` since the mock data
  doesn't model line-item-level returns.
- **`rag.documents` / guardrail field names**: verified against `koboi/config_models.py`
  directly rather than trusting the doc's YAML verbatim. `rag.documents` is `list[str | dict]`
  and the loader (`koboi/rag/registry.py:_load_documents`) reads a `path` key from each dict --
  the config as written matches that shape. `doc 01`'s excerpt also shows a top-level `mode:`
  and `rag.corpus_path:` key, neither of which exist in the schema (`mode` lives under `agent:`,
  and there's no `corpus_path` field) -- those were left out.
  `server.enabled` defaults to `False` in the schema but `koboi serve` doesn't actually gate on
  it, so it's cosmetic either way; I set it `true` to match the other shipped example configs
  (`configs/server_deploy.yaml`, `configs/e2e_full.yaml`).
- **Approval API shape**: `docs/00`'s `respond()` snippet posts `{"approved": true}` to
  `/v1/sessions/{id}/approve`. The real schema (`koboi/server/schema.py:ApproveRequest`) is
  `{"approval_id": "...", "decision": "approve"|"deny"}` -- `app.js` uses the real shape, and
  reads `approval_id` off the `pending_approval` SSE event (`PendingApprovalEvent.approval_id`),
  not `session_id` as the doc's pseudocode implies.
- **Frontend is one page, not two**: the design doc describes a separate storefront widget and
  internal approval panel. This build keeps both on `index.html` as two stacked panels (still
  no framework, no build step) rather than splitting into two HTML files, since the spec for
  this task's file tree only lists a single `index.html`/`app.js` pair.
- **Cross-origin frontend**: the web (nginx, static-only, no proxy) and koboi containers are on
  different ports (`3001` vs `8001`), so `app.js` calls `http://localhost:8001` directly instead
  of a relative path, and `config/agent.yaml` sets `guardrails`-unrelated
  `server.cors.allow_origins: ["*"]` so the browser is allowed to do that. In production you'd
  put both behind one reverse-proxy host instead.
- **`auth_required: false`**: set for this local smoke-test POC only, per the task spec. In
  production this must be `true`, with tokens minted via `koboi keys create` and sent as
  `Authorization: Bearer <token>` on every request (`docs/00` §4) -- `app.js` has the header
  plumbing in place behind an `AUTH_REQUIRED` flag, just toggled off here.
- **`agent.mode: act`, not `chat`**: found via e2e testing. `koboi/hooks/mode_hook.py`'s
  `ModeHook` blocks every tool call in CHAT/PLAN mode unless the tool name matches a small
  hardcoded whitelist (`read`, `search`, `grep`, `find`, `list`, `glob`, `web_search`,
  `web_fetch`, `calculator`, `delegate_tasks`) -- it does not consult `risk_level` at all. That
  means `lookup_order` and `check_return_eligibility`, despite being `RiskLevel.SAFE`, would be
  rejected outright in `chat` mode with "tool 'lookup_order' is not allowed. Switch to ACT or
  AUTO mode" -- contradicting `docs/01`'s claim that these run immediately in chat mode. Since
  koboi core isn't modified for this build, the fix is `agent.mode: act`: `AsyncCallbackApprovalHandler`
  auto-approves `SAFE` tools regardless of mode (`koboi/guardrails/approval.py`), so `act` mode
  gets the same "SAFE tools run immediately" behavior while still pausing `DESTRUCTIVE` tools
  for human approval -- verified live in the e2e run below (`initiate_refund` correctly emits
  `pending_approval` while `lookup_order`/`check_return_eligibility` execute without a prompt).
  Worth flagging upstream: custom `SAFE` tools have no way to join the CHAT-mode whitelist today.
- **`tools.builtin`** includes `memory_store`/`memory_recall` (not in the task's YAML skeleton)
  so the "chat mode with memory" built-in-for-free behavior from `docs/01` is actually wired up,
  matching the design doc's claim that conversations remember context turn to turn.

## Production notes

- Flip `server.auth_required: true` and mint keys with
  `docker compose run --rm koboi koboi keys create --label prod`.
- Swap `sandbox.backend: passthrough` (implicit default) for `restricted` and give it a
  per-session workdir, per `configs/server_deploy.yaml` in the koboi-agent repo.
- Wire `initiate_refund` to Shopify's real refund endpoint and `lookup_order` to the Shopify
  Admin API -- both are currently mocked in-memory for this demo.
- Consider an auto-approve threshold (e.g. refunds under $50) via a custom approval handler
  (`docs/00` §5) instead of routing every refund to a human, if support volume warrants it.
