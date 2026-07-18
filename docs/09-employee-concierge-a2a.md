# 09 -- Internal Services: Cross-Department Employee Concierge (A2A)

> Design doc for [`../employee-concierge/`](../employee-concierge/). Read [`00-consuming-koboi-server.md`](00-consuming-koboi-server.md) first.

## The business

**Northwind** -- fictional internal IT / employee-services. Employees ask for help spanning departments: a
broken laptop (IT), an access request (IT), a desk move (Facilities), a building issue (Facilities). The
right answer is **each department running its own agent**, with a front door that routes to the right one(s).

## The app

Three koboi instances:

- **`concierge`** (front door) -- talks to the employee; uses `call_peer_agent` to fan out to the relevant
  peer(s); carries the cross-cutting concerns (command-hook ticketing, proactive memory, handover).
- **`peer-it`** -- IT desk (asset lookup, password reset, access requests; policy-denies prod-admin).
- **`peer-facilities`** -- Facilities desk (desk moves, maintenance reports).

Each peer is a full koboi instance with its own tools; the concierge only *calls* them over HTTP.

## Built in vs. custom

| Need | Built in (YAML) | Custom (`concierge_ext`) |
|---|---|---|
| Route to / collaborate with a department agent | `peers` + `call_peer_agent` | -- |
| Accept inbound peer calls | `peers.inbound_tokens` (per peer) | -- |
| Open an ITSM ticket on resolution | `hooks.on_event` (command hook) | `scripts/open_ticket.py` |
| Block policy-violating access | `policy.rules` (on peer-it) | -- |
| Remember the employee | `memory.proactive` (concierge) | -- |
| Hand off complex cases | `transfer_to_human` + `handover.digest` | -- |
| Do the IT / Facilities work | -- | `it_tools`, `facilities_tools` |

## Three A2A requirements (found by running it)

1. **Auth is forced on** for any server with outbound peers (`peer_registry.has_peers` ⇒ Bearer required
   on every endpoint; `auth_required:false` can't override). The concierge carries `CONCIERGE_API_KEY`.
2. **Peer agents need `sandbox.backend: restricted`** -- `peer_invoke` on an `act`-mode agent refuses
   passthrough (500 `PermissionError` otherwise).
3. **Policy gates the tool owner** -- `request_access` lives on peer-it, so the deny rule is there, not on
   the concierge (which only calls `call_peer_agent`).

## Status

**Live-verified (2026-07-18)** via the shared gateway: IT request round-trips through `call_peer_agent` to
peer-it and back; prod-admin is policy-denied on peer-it; the command hook writes tickets; a peer failure
falls back to `transfer_to_human`. Uses unverified static-bearer peers (not `org_secret`) to avoid a
compose startup-order race.
