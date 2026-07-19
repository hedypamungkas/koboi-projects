# Internal IT / Employee Services -- Cross-Department Concierge (A2A)

Runnable build for [`docs/09-employee-concierge-a2a.md`](../docs/09-employee-concierge-a2a.md)
(Northwind, fictional). Read [`docs/00-consuming-koboi-server.md`](../docs/00-consuming-koboi-server.md) first.
**This is the only multi-container use case in the repo** -- three koboi instances collaborate over HTTP.

## What this demonstrates

The **first use case built on koboi 0.18's cross-instance agent-to-agent (A2A)**:

- **Peers / A2A** -- a front-door `concierge` uses the built-in `call_peer_agent` to collaborate with two
  **separate** koboi instances (`peer-it`, `peer-facilities`), each running its own tools, over HTTP.
- **Declarative command hooks** -- `hooks.on_event` spawns `scripts/open_ticket.py` on every resolution.
  **No Python inside the agent** (config-driven external command, `fire_and_forget`).
- **Policy rules** -- `policy.rules` on `peer-it` hard-denies `request_access` for `prod-admin`/`root`.
- **Proactive long-term memory** -- `memory.proactive` on the concierge remembers the employee.
- **Human handover** -- complex/unresolved cases hand to a human coordinator (`transfer_to_human`).

**Live-verified (2026-07-18):**
- IT request → `call_peer_agent` → peer-it resolved (looked up AST-1001, returned troubleshooting); the
  command hook wrote `/data/tickets.jsonl`.
- prod-admin request → routed to peer-it → `request_access(prod-admin)` **policy-denied**; the denial
  flowed back to the employee.
- Earlier (forced) peer failure → concierge fell back to `transfer_to_human` with a clear reason.

## The topology

```
   employee ──▶ web:3009 │  concierge (8009) [auth: CONCIERGE_API_KEY]   call_peer_agent + hooks + memory
                            └─────┬───────────────────┬────┘
                  call_peer_agent │                   │ call_peer_agent
                            ┌─────▼────┐        ┌─────▼──────────┐
                            │ peer-it  │        │ peer-facilities│   (sandbox: restricted; inbound_tokens)
                            └──────────┘        └────────────────┘
```

All three build from the **same image**; `KOBOI_CONFIG` selects each one's config. The concierge reaches
peers over the compose network at `http://peer-it:8000` / `http://peer-facilities:8000`.

## Three A2A requirements the configs enforce (each cost a live run to find)

1. **The concierge MUST carry an API key (`CONCIERGE_API_KEY`).** With outbound peers configured,
   `peer_registry.has_peers` is true, so koboi's auth middleware (`koboi/server/auth.py`) demands a Bearer
   token on every endpoint -- `auth_required: false` **cannot override that** (dev mode only applies when
   no credentials of any kind exist). So `concierge.yaml` sets `auth_required: true` + `api_keys`. The
   frontend sends it (`window.KOBOI_API_KEY`, default matches `.env`). This matches the shipped
   `configs/a2a_*.yaml`, which all set `auth_required: true`.
2. **Peer agents MUST set `sandbox.backend: restricted`.** A2A `peer_invoke` on an `act`-mode agent refuses
   the default `passthrough` (`koboi/server/app.py:_run_peer_agent`, same unattended-safety gate as jobs).
   Without it the peer returns 500 `PermissionError`. Both peer configs set `restricted` (inert for their
   plain-Python tools; just satisfies the gate).
3. **Policy lives on the tool owner, not the concierge.** `request_access` is a `peer-it` tool; the
   concierge only calls `call_peer_agent`, so a `request_access` rule on the concierge never fires. The
   deny rule is on `peer_it.yaml`.

## Deliberate deviations / notes

- **Verified-A2A (`org_secret`) is now enabled** (was static bearer). All three instances share
  `A2A_ORG_SECRET` (`.env`); each advertises a signed agent-card (`org` + `org_secret` + `public_base_url`),
  and the concierge's `verify_all` HMAC-checks every peer's org-claim at startup before it's callable
  (verified-only). `verify_all` is **non-fatal** (`koboi/server/peers.py:139-160`) -- an unreachable or
  unverified peer is dropped + warned ("uncallable"), not a boot crash, which is exactly what lets us turn
  this on despite the compose start-order race below. Verified: each peer's `/.well-known/agent-card`
  HMAC-verifies True; `call_peer_agent` -> peer-it `POST /v1/peer/invoke 200 OK`.
- **Startup order still matters for the *first* call.** Compose `depends_on` waits for *start*, not
  *readiness*. If `verify_all` runs before a peer serves its card, that peer is unverified + uncallable and
  the first `call_peer_agent` to it fails -> the concierge falls back to `transfer_to_human` (verified) --
  restart the concierge to re-verify, then retry.
- **Command hook is fire-and-forget.** `open_ticket.py` writes `/data/tickets.jsonl`; `abort_on_error:
  false` + `fire_and_forget: true` mean a slow ITSM never breaks the loop.

## Layout

```
employee-concierge/
  config/
    concierge.yaml          # front door: peers + call_peer_agent + hooks + proactive memory + handover (auth: true + key)
    peer_it.yaml            # IT peer: inbound token + it_tools + sandbox restricted + policy.rules (deny prod-admin)
    peer_facilities.yaml    # Facilities peer: inbound token + facilities_tools + sandbox restricted
  src/concierge_ext/
    it_tools.py             # lookup_asset, reset_password, request_access (SAFE)
    facilities_tools.py     # lookup_desk, book_desk_move, report_maintenance (SAFE)
  scripts/open_ticket.py    # command-hook target (ServiceNow-style ticket stub)
  backend/Dockerfile        # one image; KOBOI_CONFIG selects the config at runtime
  frontend/                 # employee concierge chat (sends CONCIERGE_API_KEY)
  docker-compose.yml        # 3 koboi services (8009/8011/8012) + web (3009)
  pyproject.toml            # installable `concierge_ext`, shared by all 3
```

## Running it

```bash
cd employee-concierge
cp .env.example .env   # fill in OPENAI_* + EMBEDDING_*; CONCIERGE_API_KEY defaults to a smoke key
docker compose build
docker compose up -d peer-it peer-facilities   # peers first (readiness)
docker compose up -d concierge web
```

- Front door: `http://localhost:8009` (auth: `Authorization: Bearer $CONCIERGE_API_KEY`)
- IT peer: `http://localhost:8011` &middot; Facilities peer: `http://localhost:8012`
- Frontend: `http://localhost:3009`

### Smoke test

```bash
KEY=concierge-smoke-key-1234   # matches .env CONCIERGE_API_KEY
curl -sf http://localhost:8009/healthz

# IT request -> concierge -> call_peer_agent -> peer-it
curl -s -N --max-time 150 -X POST http://localhost:8009/v1/chat/stream \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"message":"I am emp-42 and my laptop AST-1001 will not boot. Help.","mode":"act"}'

# prod-admin -> policy deny on peer-it
curl -s -N --max-time 150 -X POST http://localhost:8009/v1/chat/stream \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"message":"Grant emp-42 prod-admin access for deploy work.","mode":"act"}'

docker compose exec concierge cat /data/tickets.jsonl   # command-hook tickets
```

## Frontend

Plain HTML + vanilla JS. Single chat column to the concierge (`streamChat()`, doc 00 §3, `X-Session-Id`,
`mode: "act"`, sends `Authorization: Bearer <CONCIERGE_API_KEY>`). Quick-action buttons pre-fill common
requests. `call_peer_agent` fan-outs render as `tool_call` events. CORS required (3009 ≠ 8009).
