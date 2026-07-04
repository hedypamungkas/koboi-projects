# Finance & Accounting Ops -- Vendor Invoice Reconciliation

Runnable build for [`docs/03-finance-invoice-reconciliation.md`](../docs/03-finance-invoice-reconciliation.md)
(Ledgerline Manufacturing). Read that doc and
[`docs/00-consuming-koboi-server.md`](../docs/00-consuming-koboi-server.md) first -- this README only covers
what's specific to running this build, plus the deliberate simplifications made to get it running end to end.

## What this demonstrates

- **MCP as a client** -- koboi connects to `erp_mcp_server.py`, which exposes three read-only ERP lookups
  (`fetch_invoice`, `fetch_purchase_order`, `three_way_match`). All three come in as `RiskLevel.SAFE`
  automatically -- koboi has no way to mark an MCP tool `DESTRUCTIVE`.
- **A local DESTRUCTIVE tool** -- `post_journal_entry` (`src/finance_ext/tools.py`) is the one write, kept
  local on purpose so it can carry `RiskLevel.DESTRUCTIVE` and trigger koboi's built-in human-approval pause.
- **A custom hook** -- `InvoiceAuditHook` (`src/finance_ext/hooks.py`) logs every `PRE_TOOL_USE` /
  `POST_TOOL_USE` event, from both the local tool and the MCP-sourced tools, to
  `/data/audit/invoice_audit.jsonl`.

## Deliberate deviations from the design doc

The design doc describes a fuller, more "production" shape than this POC runs, for two reasons documented
here plainly (not mistakes):

1. **MCP transport: stdio, not Streamable HTTP.** The design doc has `erp-mcp` as a separately-deployed
   service reached over Streamable HTTP (`mcp.servers: [{transport: streamable-http, url: ...}]`). The only
   MCP pattern with a real, working example in koboi-agent is **stdio** (`mcp_servers/todo_server.py`,
   `command`/`args`, subprocess) -- there's no proven example of the Streamable-HTTP transport wired up. For
   this runnable build, `erp_mcp_server.py` runs as a **stdio subprocess co-located in the same container as
   koboi** (see `backend/Dockerfile` and `config/agent.yaml`'s `mcp.servers` entry:
   `command: python3`, `args: ["/app/erp_mcp_server.py"]`), instead of a separate `erp-mcp` service/container.
   **A production deployment would split this into its own HTTP service**, as the design doc intends, once a
   Streamable-HTTP MCP pattern is proven out in koboi-agent.
2. **No YAML/entry-point way to preload a custom hook.** `koboi serve config/agent.yaml` (the bare CLI) has
   no config key for registering a hook -- `koboi.server.app.create_app()` only accepts `extra_hooks=[...]`
   as a Python kwarg. `src/finance_ext/entrypoint.py` is a small custom entrypoint that calls `create_app()`
   and runs uvicorn itself; `backend/Dockerfile`'s `CMD` runs `python -m finance_ext.entrypoint` instead of
   `koboi serve`. Two things worth calling out about it:
   - `create_app`'s `extra_hooks` param does **not** accept a raw `Hook` subclass instance directly --
     `AgentPool._build_agent` (koboi/server/pool.py) only handles a plain callable, or a
     `(callback, events)` tuple, wrapping it in `CallbackHook`. Passing `InvoiceAuditHook()` as-is crashes
     every request with `TypeError: 'InvoiceAuditHook' object is not subscriptable` -- caught during this
     build's e2e pass. `entrypoint.py` instead passes `(audit_hook.execute, audit_hook.handles())`.
   - Because this entrypoint replaces `koboi.server.app.serve_app()` entirely, it also reproduces
     `serve_app`'s one safety-relevant check by hand: refusing to bind a non-loopback host when
     `server.auth_required` is true and no API keys are configured, instead of silently serving open. Worth
     knowing if you copy this pattern elsewhere -- it's easy to drop that guard along with the rest of
     `serve_app`'s logic.
   - koboi-agent also has a `koboi.hooks.registry.register_hook(HookEntry(...))` global registry, consulted
     by the same `build_hook_chain()` that both `koboi serve` and this custom entrypoint end up calling --
     in principle a consumer module could call it at import time and skip the custom entrypoint entirely.
     We kept the explicit `entrypoint.py` + `extra_hooks` path instead: it's the mechanism this build's spec
     called for, and it keeps `InvoiceAuditHook`'s wiring visible in one file rather than as an import-order-
     dependent side effect of loading `tools.custom`.

Smaller, explicitly-noted simplifications:

- **`server.auth_required: false`** in `config/agent.yaml`. Every request in this POC is unauthenticated --
  fine for a local smoke test, but production would set this `true` and issue tokens via `koboi keys create`
  (doc 00 Sec.4).
- **`sandbox.backend: restricted`** is left on (per the design doc, since the job path runs unattended
  overnight) and booted fine in testing. If it ever blocks boot in your environment, it's safe to drop back
  to the `passthrough` default for this POC -- it only affects subprocess tools (`run_shell`, `git_*`,
  filesystem), not the MCP stdio subprocess or the local `post_journal_entry` tool, neither of which declare
  a `sandbox` dependency.
- **`agent.mode: act` is set as the config default (fixed post-merge, was a real bug).** koboi's default CHAT
  mode blocks any tool call whose name isn't in a small hardcoded builtin-tool allowlist
  (`koboi/hooks/mode_hook.py`'s `_READ_ONLY_TOOLS`: `read`, `search`, `grep`, `find`, `list`, `glob`,
  `web_search`, `web_fetch`, `calculator`, `delegate_tasks`) -- it has no way to know a custom/MCP tool like
  `three_way_match` is read-only, so it gets rejected in CHAT mode with `"CHAT mode: tool 'three_way_match' is
  not allowed"`, same as a real write would be. This build originally only worked because every request
  happened to pass `"mode":"act"` explicitly -- any caller that omitted it (a real risk, since it's easy to
  forget) silently degraded instead of erroring. Fixed by setting `agent.mode: act` directly in
  `config/agent.yaml`, so the app is correct by default regardless of what any individual request sends.
  Separately, `post_journal_entry`'s `RiskLevel.DESTRUCTIVE` still triggers the approval pause regardless of
  mode (mode and the approval gate are independent checks in koboi's tool pipeline; only YOLO mode skips
  approval). A cleaner long-term fix would be a koboi-side way to mark a specific custom/MCP tool as
  chat-mode-safe; there isn't one today.
- **Denied/timed-out approvals aren't in the audit log.** koboi resolves DESTRUCTIVE-risk approval *before*
  `PRE_TOOL_USE` hooks run, so a rejected `post_journal_entry` call returns early and `InvoiceAuditHook`
  never sees it -- only calls that clear approval (or never needed it) get logged. An auditor asking "what
  did the controller reject" needs koboi's own approval/trust-DB records for that, not this file. Verified
  live: the audit log after this build's e2e run has rows for the successful `three_way_match` lookup and
  the *approved* `post_journal_entry`, and would have skipped an unapproved one entirely.

## Layout

```
finance-reconciliation/
  pyproject.toml           # installable `finance_ext` package (src/ layout)
  config/agent.yaml        # koboi config: llm, custom tool, mcp server, sandbox, server
  src/finance_ext/
    tools.py               # post_journal_entry (local, DESTRUCTIVE)
    hooks.py                # InvoiceAuditHook (PRE/POST_TOOL_USE -> /data/audit/invoice_audit.jsonl)
    entrypoint.py            # create_app(cfg, extra_hooks=[...]) + uvicorn.run (see deviation #2)
  erp_mcp_server.py        # koboi.mcp.server.MCPServer, stdio, mock ERP (see deviation #1)
  backend/Dockerfile        # koboi-agent[api] + finance_ext + erp_mcp_server.py, one container
  frontend/                 # controller dashboard: flagged-invoice panel + chat, vanilla JS, no build step
  docker-compose.yml
```

## Running it

```bash
cd finance-reconciliation
docker compose build
docker compose up -d
```

Copy `.env.example` to `.env` in this directory and fill in your own `OPENAI_API_KEY` (and
`OPENAI_MODEL`/`OPENAI_BASE_URL` if needed). `docker-compose.yml` reads it via `env_file: [.env]`.
`.env` is gitignored -- never commit real credentials.

- Backend: `http://localhost:8003` (koboi's port 8000 published)
- Frontend: `http://localhost:3003` (controller dashboard)

### Smoke test

```bash
curl -sf http://localhost:8003/healthz
curl -sf http://localhost:8003/readyz

# First turn: read-only three-way match via the MCP subprocess. mode:"act" is required --
# see "Every request pins mode: act" above.
curl -s -N -X POST http://localhost:8003/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message": "Run a three-way match on invoice INV-8842 against PO PO-4471", "mode": "act"}'
# Capture the X-Session-Id response header, then:

curl -s -N -X POST http://localhost:8003/v1/chat/stream -H "Content-Type: application/json" \
  -H "X-Session-Id: <id-from-above>" \
  -d '{"message": "post that entry to GL account 5000", "mode": "act"}'

docker compose down
```

Expect the first call to show a `tool_call` / `tool_result` pair for `three_way_match` (proving the MCP
stdio subprocess started and answered), then `complete`. Expect the second call to produce a
`pending_approval` event for `post_journal_entry` (proving its `RiskLevel.DESTRUCTIVE` triggers koboi's
approval pause) -- approving/rejecting it isn't required for the smoke test, but if you want to see the full
loop close, grab `approval_id` from that event and:

```bash
curl -s -X POST http://localhost:8003/v1/sessions/<session-id>/approve -H "Content-Type: application/json" \
  -d '{"approval_id": "<approval-id-from-event>", "decision": "approve", "scope": "once"}'
```

which unblocks the still-open second `curl -N` call and lets it finish with a `tool_result` of
`"Posted 4200 to 5000 for invoice INV-8842 (mock -- no real ERP)."` -- verified live during this build.

Tail the audit trail from the host via the named volume:

```bash
docker compose exec koboi cat /data/audit/invoice_audit.jsonl
```

If the MCP subprocess fails to start or the entrypoint errors, check `docker compose logs koboi`.

## Frontend

Plain HTML + vanilla JS (`frontend/index.html`, `frontend/app.js`), no build step. Left panel is a static
mock list of flagged invoices (mirroring `erp_mcp_server.py`'s sample data); clicking one pre-fills a
three-way-match question in the chat box. The chat box is wired to a `streamChat()` helper matching doc 00
Sec.3, extended to track `X-Session-Id` across turns and always send `mode: "act"` (see deviations above).
When a `pending_approval` SSE event arrives, an inline approve/reject card renders and posts to
`POST /v1/sessions/{id}/approve` with `{approval_id, decision, scope}` (the real `ApproveRequest` schema --
note this is a couple of fields richer than doc 00's illustrative `{approved: true}` snippet).

Because the frontend (`localhost:3003`) and backend (`localhost:8003`) are different origins, browser
`fetch()` calls need CORS -- koboi only adds `CORSMiddleware` when `server.cors` is explicitly set in YAML
(no `cors:` block means no cross-origin reads at all, by design). `config/agent.yaml` sets
`server.cors.allow_origins: ["http://localhost:3003"]` and `expose_headers: ["X-Session-Id"]` (without the
latter, the browser's fetch API silently hides that response header from JS, breaking session continuity
across chat turns even though curl works fine). Verified with `curl -i -X OPTIONS ... -H "Origin:
http://localhost:3003"` during this build.
