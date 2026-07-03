# 03 — Finance & Accounting Ops: Vendor Invoice Reconciliation

> Read [`00-consuming-koboi-server.md`](00-consuming-koboi-server.md) first — this doc only covers what's
> specific to this sector. Endpoints, auth, SSE shape, and extension mechanics are not repeated here.

## Business problem

Month-end close requires matching hundreds of vendor invoices against purchase orders (POs) and
goods-received notes (GRNs), flagging discrepancies, and — only after a human controller signs off —
posting approved journal entries to the ERP general ledger. This is a regulated, auditable, maker-checker
workflow (SOX-style controls): the system that *proposes* a posting must never be the same actor that
*approves* it, and every action must leave a durable trail.

## 1. Context & assumptions

- Invoices, POs, and GRNs live in an ERP (NetSuite/SAP-style) reachable via a REST API; this sector package
  wraps that API behind koboi tools rather than talking to the ERP database directly.
- A **review queue** (a small table — could be a table in the ERP, or a side SQLite/Postgres store owned by
  this package) holds discrepancy records produced by the matching pass, pending controller action.
- This is a **hybrid workload**, and the doc explicitly designs for both koboi run modes rather than picking
  one:
  - **Autonomous job** (`POST /v1/jobs`, `mode: act`) — nightly bulk 3-way matching. Read-only against the
    ERP (fetch + compare), writes only to the review queue. No human is present; per doc 00 §1, jobs get
    **no HITL** — which is exactly why this pass never calls `post_journal_entry`.
  - **Interactive chat** (`POST /v1/chat/stream`) — the controller opens a session, asks the agent to
    summarize the review queue, investigate a specific discrepancy, or post an entry. `post_journal_entry`
    is `RiskLevel.DESTRUCTIVE`, so calling it from chat mode triggers koboi's `pending_approval` SSE event;
    the controller resolves it via `POST /v1/sessions/{id}/approve`. This is the *only* path that can touch
    the ledger, by construction — the job path's tool set never includes `post_journal_entry` at all (see
    §3 on config shape).
- `yolo` mode is never enabled for this deployment (`server.allow_yolo` left unset/`false`) — a regulated
  posting workflow should never bypass approval, and doc 00 confirms jobs reject `yolo` unconditionally
  regardless of server config.

## 2. Architecture

```
                        ┌──────────────────────────────────────────┐
                        │     koboi server (single node, self-hosted)│
                        │   config/agent.yaml  (koboi serve ...)     │
                        └──────────────────────────────────────────┘
        nightly cron                                        controller (browser/CLI)
        mode: act, job                                       interactive session
              │                                                     │
              ▼                                                     ▼
   POST /v1/jobs                                        POST /v1/sessions
   {mode:"act",                                          POST /v1/chat/stream
    message:"reconcile invoices                          {message:"summarize today's
     received since <ts>"}                                 discrepancies"}
              │                                                     │
              ▼                                                     │
   ┌────────────────────────┐                                       │
   │ fetch_invoice           │  SAFE, read-only                     │
   │ fetch_purchase_order    │  (sandbox.backend: restricted,       │
   │ three_way_match         │   mandatory per doc 00 §6)            │
   └───────────┬─────────────┘                                       │
               │ writes discrepancy rows                             │
               ▼                                                     │
       ┌───────────────────┐        controller reads/queries  ◄──────┘
       │   review queue     │◄───────────────────────────────────────┐
       │ (discrepancies,    │                                        │
       │  match status)     │        "post the $4,200 entry for      │
       └───────────────────┘         invoice INV-8842"                │
                                                     │                │
                                                     ▼                │
                                       post_journal_entry (DESTRUCTIVE)
                                                     │
                                    pending_approval SSE event emitted
                                                     │
                                   POST /v1/sessions/{id}/approve {approved:true}
                                                     │
                                                     ▼
                                            ERP general ledger (write)

   Every PRE_TOOL_USE / POST_TOOL_USE event, on BOTH paths, is captured by
   InvoiceAuditHook → append-only JSONL under /data/audit/ (SOX trail).
```

Both the job and the chat path run against the **same** koboi server process, config, tool registry, and
audit hook — see §3 for why this is one config rather than two.

## 3. Project structure

```
finance-invoice-reconciliation/
├── pyproject.toml
├── config/
│   └── agent.yaml
├── src/
│   └── finance_ext/
│       ├── __init__.py
│       ├── tools.py         # fetch_invoice, fetch_purchase_order, three_way_match, post_journal_entry
│       ├── hooks.py         # InvoiceAuditHook (PRE/POST_TOOL_USE)
│       └── approval.py      # optional: DualSignoffApprovalHandler (see §5)
├── app.py                   # entrypoint: import finance_ext.hooks (registers hook), then serve
└── Dockerfile
```

**One config, not two.** Both the nightly job and the controller's chat session hit the same
`config/agent.yaml`, differentiated purely by the request-time `mode` knob (doc 00 §1) — `mode: act` for
the job, default `chat`/`plan` for the interactive session. We deliberately did **not** split this into a
"batch config" and an "interactive config": SOX auditability wants one tool registry and one audit hook
applied uniformly, not two configs that could drift out of sync on which tools are exposed or how they're
logged. `server.allowed_modes: [chat, plan, act]` covers both entry points from a single deployment; `auto`
and `yolo` are left out.

## 4. Key code skeletons

### (a) Read-only ERP tools — `SAFE`

```python
"""finance_ext/tools.py -- ERP-facing tools for invoice reconciliation."""
import json
from koboi.tools.registry import tool
from koboi.types import RiskLevel

from finance_ext.erp_client import ErpClient  # thin wrapper around the ERP's REST API

_erp = ErpClient()  # reads base URL / creds from env at import time


@tool(
    name="fetch_invoice",
    description="Fetch a vendor invoice (header + line items) by invoice ID.",
    parameters={
        "type": "object",
        "properties": {"invoice_id": {"type": "string"}},
        "required": ["invoice_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def fetch_invoice(invoice_id: str) -> str:
    return json.dumps(await _erp.get_invoice(invoice_id))


@tool(
    name="fetch_purchase_order",
    description="Fetch a PO plus its goods-received note(s) by PO number.",
    parameters={
        "type": "object",
        "properties": {"po_number": {"type": "string"}},
        "required": ["po_number"],
    },
    risk_level=RiskLevel.SAFE,
)
async def fetch_purchase_order(po_number: str) -> str:
    return json.dumps(await _erp.get_po_with_grn(po_number))


@tool(
    name="three_way_match",
    description=(
        "Compare an invoice against its PO and GRN line items; return match status "
        "(matched / price_variance / qty_variance / missing_grn) and write a discrepancy "
        "record to the review queue if not fully matched."
    ),
    parameters={
        "type": "object",
        "properties": {
            "invoice_id": {"type": "string"},
            "po_number": {"type": "string"},
        },
        "required": ["invoice_id", "po_number"],
    },
    risk_level=RiskLevel.SAFE,
)
async def three_way_match(invoice_id: str, po_number: str) -> str:
    result = await _erp.match(invoice_id, po_number)
    if result["status"] != "matched":
        await _erp.review_queue_write(invoice_id, result)
    return json.dumps(result)
```

### (b) The one write path — `DESTRUCTIVE`

```python
@tool(
    name="post_journal_entry",
    description=(
        "Post an approved journal entry to the ERP general ledger for a reconciled invoice. "
        "Requires human approval — do not call without an explicit controller instruction."
    ),
    parameters={
        "type": "object",
        "properties": {
            "invoice_id": {"type": "string"},
            "gl_account": {"type": "string"},
            "amount": {"type": "number"},
            "memo": {"type": "string"},
        },
        "required": ["invoice_id", "gl_account", "amount"],
    },
    risk_level=RiskLevel.DESTRUCTIVE,
)
async def post_journal_entry(invoice_id: str, gl_account: str, amount: float, memo: str = "") -> str:
    return json.dumps(await _erp.post_journal_entry(invoice_id, gl_account, amount, memo))
```

Note the **job config never registers `post_journal_entry`** — enforce this by giving the job path a
narrower `tools.enabled` allowlist, not just by relying on jobs having no HITL. Belt and suspenders: even
if that allowlist slipped, jobs can't approve a `DESTRUCTIVE` call anyway (doc 00 §1).

### (c) SOX audit hook — `PRE_TOOL_USE` / `POST_TOOL_USE`

```python
"""finance_ext/hooks.py -- append-only audit trail for every tool call."""
import json
import time

from koboi.hooks.chain import Hook, HookContext, HookEvent
from koboi.hooks.registry import HookEntry, register_hook

_AUDIT_PATH = "/data/audit/invoice_audit.jsonl"


class InvoiceAuditHook(Hook):
    priority = 80  # post-processing band, same as koboi's builtin AuditHook

    def handles(self) -> list[HookEvent]:
        return [HookEvent.PRE_TOOL_USE, HookEvent.POST_TOOL_USE]

    async def execute(self, ctx: HookContext) -> HookContext:
        record = {
            "ts": time.time(),
            "event": ctx.event.value,
            "iteration": ctx.iteration,
            "agent_model": ctx.agent.model if ctx.agent else None,
            "tool_name": ctx.tool_name,
            "arguments": ctx.tool_arguments,
            "result": ctx.tool_result if ctx.event == HookEvent.POST_TOOL_USE else None,
        }
        with open(_AUDIT_PATH, "a") as f:
            f.write(json.dumps(record) + "\n")
        return ctx


register_hook(
    HookEntry(
        name="InvoiceAuditHook",
        config_key="finance_ext.audit",
        should_add=lambda config, **kw: True,
        factory=lambda config, **kw: InvoiceAuditHook(),
    )
)
```

`HookContext` (per `koboi/hooks/chain.py`) does not carry a session/job ID today — see open questions below
on correlating audit rows back to a specific chat session or job run.

### (d) `config/agent.yaml`

```yaml
agent:
  name: invoice-reconciliation
  mode: chat  # default; overridden per-request via the `mode` knob (doc 00 §1)

tools:
  enabled: [fetch_invoice, fetch_purchase_order, three_way_match, post_journal_entry]
  custom:
    - module: finance_ext.tools

guardrails:
  approval:
    require_for: [destructive]   # post_journal_entry always pauses for approval in chat mode

sandbox:
  backend: restricted            # mandatory for the job/batch path -- see §6

server:
  allowed_modes: [chat, plan, act]
  auth_required: true
  limits:
    max_iterations_cap: 25
```

`finance_ext.hooks` is **not** referenced here — per doc 00 §5, hooks have no YAML `custom_modules` key and
must be imported at the app entrypoint before `KoboiAgent.from_config()` runs (see `app.py` in §3, and the
open question on how that composes with the `koboi serve` CLI).

## 5. Maker-checker design

`RiskLevel.DESTRUCTIVE` on `post_journal_entry` plus koboi's default HITL flow *is* the maker-checker
control: the agent (maker) proposes a posting by calling the tool; execution pauses and emits
`pending_approval` over SSE; a human controller (checker) reviews the proposed `arguments` and resolves it
via `POST /v1/sessions/{id}/approve`. Nothing reaches the ERP until that approval lands. Because jobs never
get a `pending_approval` channel at all, routing the posting step through chat-only isn't just a policy
choice — it's the only path capable of pausing for a human.

If the business needs something beyond koboi's default single-approver HITL — e.g. **dual sign-off above a
dollar threshold**, or routing high-value postings to a different approver group — that's exactly the seam
doc 00 §5 calls out: subclass `ApprovalHandler` and override `should_approve(tool_name, arguments,
risk_level)` to add threshold/role logic (parse `arguments` for `amount`, check it against a config'd
threshold, require a second `approve` call from a different principal before returning `True`). This is
wired at `AgentAssembler` build time on the **imperative** path — see the open question below on whether
that's reachable from the `koboi serve` CLI or requires standing up our own ASGI entrypoint.

## 6. Deployment

Single self-hosted node per doc 00 §6: `pip install "koboi-agent[api] @ git+..."`, `pip install -e .` this
package, `koboi serve config/agent.yaml --host 0.0.0.0 --port 8000`. `/data` persists `koboi_memory.db*`,
`keys.json`, and — for this sector — the `/data/audit/invoice_audit.jsonl` trail, which must be included in
backup/retention scope alongside the SQLite files.

`sandbox.backend: restricted` is **mandatory**, not optional, for the job/batch path: doc 00 §1 notes
autonomous jobs auto-approve every tool call inside a "mandatory `sandbox.backend=restricted`" — since the
nightly matching job runs unattended against a live ERP connection, restricted cwd/env/PATH/network
isolation is the only backstop between a compromised or malfunctioning matching pass and the rest of the
host. This applies to the whole deployment (one config, one sandbox setting — see §3), so the interactive
chat path inherits the same restricted sandbox.

## 7. What this demonstrates

This sector showcases running **chat and job modes from one koboi deployment**, cleanly split by task shape
rather than by separate infrastructure — bulk/unattended work as a job, human-gated work as chat.
It highlights `RiskLevel.DESTRUCTIVE` as the natural boundary for a regulated write action, and shows a
`PRE_TOOL_USE`/`POST_TOOL_USE` hook doing compliance work (an immutable audit trail) that has nothing to do
with the LLM's reasoning loop — a use case koboi's hook system is designed for but doesn't ship out of the
box.

## Open questions

- **Hook import ordering vs. the `koboi serve` CLI**: doc 00 says custom hooks must be imported before
  `KoboiAgent.from_config()` runs, "e.g. in your app's entrypoint" — but this sector wants to just run
  `koboi serve config.yaml`. Does the CLI support a `--preload` / plugin-discovery mechanism, or does using
  a custom hook require wrapping koboi's ASGI app ourselves instead of using `koboi serve` directly?
- **Custom `ApprovalHandler` reachability**: doc 00 says approval handlers are wired at `AgentAssembler`
  build time on "the imperative path." Is that reachable at all when serving via the `koboi serve` CLI, or
  does dual sign-off / threshold-based approval require standing up our own server process around
  `KoboiAgent`?
- **Audit-to-session correlation**: `HookContext` (as read from `koboi/hooks/chain.py`) has no session or
  job ID field. For a SOX trail we need to tie each audit row back to the originating session/job — is
  there a way to get that (e.g. via `ctx.metadata`, or a value the pipeline sets before the hook fires), or
  does this need a request-ID-in-`ctx.metadata` convention added upstream?
- **Review queue storage**: is the discrepancy review queue a table inside the existing ERP, or a side
  store this package owns? Affects whether `three_way_match` needs its own DB migration/schema.
- **Dollar threshold for dual sign-off**: what amount triggers the second approver, and who is authorized
  to be "approver #2" — is that role information available anywhere koboi can see it (e.g. per-API-key
  metadata), or does it need to be modeled entirely inside `finance_ext.approval`?
- **Retention/immutability of the audit log**: is a local append-only JSONL file sufficient for the
  compliance team, or does this need to ship to a WORM store / external SIEM — and on what cadence?
