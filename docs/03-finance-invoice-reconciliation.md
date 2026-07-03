# 03 — Finance & Accounting Ops: Vendor Invoice Reconciliation

> Builds on [`00-consuming-koboi-server.md`](00-consuming-koboi-server.md). Read that first — this doc only
> covers what's different for this sector.

> This design was written before the app existed. It's since been built and verified —
> [`../finance-reconciliation/README.md`](../finance-reconciliation/README.md) is the tested source of truth
> for anything the two disagree on.

**One-line pitch:** Every night, koboi checks vendor invoices against purchase orders and flags anything
that doesn't match. Every morning, the controller reviews the flags and approves postings — nothing reaches
the ledger without a person clicking approve.

## The scenario

Ledgerline Manufacturing is a mid-size parts maker. Its four-person finance team closes the books every
month by matching around 500 vendor invoices against purchase orders and delivery records by hand — days of
tab-switching and spreadsheet cross-checking. They want the matching automated overnight, but won't let
software post anything to the ledger on its own: the controller has to review each flagged invoice and
approve or reject the posting herself.

## What you get for free

koboi handles the "who does what, when" part with nothing custom-built:

- **Job mode** for the overnight batch — a cron job calls `POST /v1/jobs` with `mode: act`, and koboi works
  through the invoice list unattended, no server process to babysit.
- **Chat mode** for the controller's morning review — she opens a browser tab, koboi streams answers over
  SSE, and she asks questions in plain language ("why is invoice INV-8842 flagged?").
- **Built-in approval pause** — the important one for finance. Mark `post_journal_entry` as
  `RiskLevel.DESTRUCTIVE` and koboi automatically pauses before running it and sends a `pending_approval`
  event — the safety mechanism this workflow needs is already there; you just have to mark the tool right.

## What you build

Two things, because the read side and the write side deliberately live in different places.

**(a) `erp-mcp`** — three read-only ERP operations exposed as an MCP server, since Ledgerline's IT team wants
other internal tools to share the same ERP read access, not just this agent:

| Name | What it does |
|---|---|
| `fetch_invoice` | Pull an invoice (header + lines) from the ERP by ID |
| `fetch_purchase_order` | Pull a PO and its delivery record by PO number |
| `three_way_match` | Compare invoice vs. PO vs. delivery; write a discrepancy row to a review queue if anything's off |

koboi connects to it as a client — it never hosts an MCP server itself. Two transports exist in koboi-agent
(`command`/`args` stdio subprocess, and `url`/`transport: streamable-http` for a separately-hosted service),
but only the stdio form has a proven working example to copy from. So `erp_mcp_server.py` runs as a **stdio
subprocess co-located in the same container as koboi**, not the standalone service reached over Streamable
HTTP that a shared, multi-consumer ERP integration should really be — that separately-deployed shape is still
the better production target, and is worth revisiting once a Streamable-HTTP MCP pattern has a proven example
to build against. koboi treats all three tools as `RiskLevel.SAFE` automatically, with no way to mark one
`DESTRUCTIVE` — a non-issue here, since all three only read.

**(b) `post_journal_entry`** — the one write, kept local on purpose. Posting to the ledger is the step
Ledgerline won't let software do unsupervised, and MCP tools can never pause for approval — so this one stays
a local `@tool()`, `RiskLevel.DESTRUCTIVE`, to keep the approval pause:

```python
"""finance_ext/tools.py"""
from koboi.tools.registry import tool
from koboi.types import RiskLevel
from finance_ext.erp_client import ErpClient

erp = ErpClient()

@tool(
    name="post_journal_entry",
    description="Post an approved amount to the general ledger. Requires human approval.",
    parameters={...},  # invoice_id, gl_account, amount
    risk_level=RiskLevel.DESTRUCTIVE,
)
async def post_journal_entry(invoice_id: str, gl_account: str, amount: float) -> str:
    return json.dumps(await erp.post_journal_entry(invoice_id, gl_account, amount))
```

That `risk_level=RiskLevel.DESTRUCTIVE` line is the whole control: the job's tool list never includes
`post_journal_entry`, so it can only be called from chat — and calling it there always pauses for approval.

Plus an audit hook logging every tool call — from `erp-mcp` and the local tool alike — to an append-only
file, the trail an auditor will ask for later.

The audit hook:

```python
"""finance_ext/hooks.py -- logs every tool call to an append-only file"""
class InvoiceAuditHook(Hook):
    priority = 80

    def handles(self) -> list[HookEvent]:
        return [HookEvent.PRE_TOOL_USE, HookEvent.POST_TOOL_USE]

    async def execute(self, ctx: HookContext) -> HookContext:
        row = {"ts": time.time(), "event": ctx.event.value, "tool": ctx.tool_name,
               "args": json.loads(ctx.tool_arguments) if ctx.tool_arguments else None,
               "result": ctx.tool_result if ctx.event == HookEvent.POST_TOOL_USE else None}
        with open("/data/audit/invoice_audit.jsonl", "a") as f:
            f.write(json.dumps(row) + "\n")
        return ctx
```

`ctx.tool_arguments` arrives as a JSON **string**, not a dict — `json.loads()` it before reading a field, same
as doc 00 §5 warns.

Hooks have no YAML key (doc 00 §5) — there's no config-driven way to preload one into `koboi serve`. Instead,
a small custom entrypoint calls `create_app()` directly and passes the hook as a `(callback, events)` tuple,
not a raw `Hook` instance (`AgentPool._build_agent` only accepts a plain callable or that tuple form — passing
`InvoiceAuditHook()` itself crashes every request):

```python
# finance_ext/entrypoint.py -- the Dockerfile's CMD runs this instead of `koboi serve`
audit_hook = InvoiceAuditHook()
app = create_app(cfg, extra_hooks=[(audit_hook.execute, audit_hook.handles())])
uvicorn.run(app, host="0.0.0.0", port=8000)
```

## Architecture

```
 nightly cron ──▶ POST /v1/jobs (mode: act) ──▶ koboi ──▶ erp_mcp_server.py (stdio subprocess,
                                                              same container as koboi -- see "What you build")
                                                              fetch_invoice / fetch_purchase_order /
                                                              three_way_match (SAFE by MCP, read-only)
                                                                         │
                                                                         ▼  review queue (discrepancies)
 controller ──▶ browser: koboi chat session ──▶ reads/asks about queue items
                                                                         │
                                                "post the $4,200 entry for INV-8842"
                                                                         ▼
                                              post_journal_entry (LOCAL tool, DESTRUCTIVE)
                                                                         │
                                                                         ▼  pending_approval SSE event
                              controller clicks Approve ──▶ POST /v1/sessions/{id}/approve
                                                                         │
                                                                         ▼  ERP general ledger, updated

 Every tool call, both paths, logged by InvoiceAuditHook -> /data/audit/invoice_audit.jsonl
```

## The frontend

A single-page dashboard for the controller: a **left panel** lists invoices flagged by last night's job
(vendor, PO, mismatch reason, amount); a **right panel** is a chat box built on `streamChat()` from doc 00
§3, where she clicks a flagged invoice and asks things like "why doesn't this match?" or "post this one."
When a `pending_approval` event arrives, an approve/reject card renders inline with the proposed posting:

```js
// added to the onEvent handler from doc 00's streamChat()
if (evt.type === "pending_approval") {
  showApprovalCard(evt.tool_call, async (approved) => {
    await fetch(`/v1/sessions/${sessionId}/approve`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
  });
}
```

## Docker

`erp_mcp_server.py` ships inside the `backend/` image and starts as a stdio subprocess of koboi itself (per
the MCP transport note above) — there's no separate `erp-mcp` service or Dockerfile for this build. A
production deployment that wants `erp-mcp` shared across other internal tools would split it into its own
container reached over Streamable HTTP once that transport has a proven koboi-agent example; this compose
file reflects the stdio shortcut actually taken.

```yaml
services:
  koboi:
    build: ./backend       # koboi-agent[api] + finance_ext + erp_mcp_server.py, one image
    ports: ["8000:8000"]
    volumes: ["koboi-data:/data"]   # memory db, keys, /data/audit/*.jsonl
    env_file: .env
  web:
    build: ./frontend               # controller dashboard, static build
    ports: ["3000:80"]
    depends_on: [koboi]
volumes:
  koboi-data:
```

Job and chat sessions hit the same koboi container — one deployment, one config, one image for the agent
and its co-located MCP subprocess. Per doc 00, the job path needs `sandbox.backend: restricted`, since it
runs unattended all night; chat sessions inherit the same config. `sandbox.backend` only governs subprocess
tools that declare a `sandbox` dependency (`run_shell`, `git_*`, filesystem) — it doesn't sandbox the MCP
subprocess or the local `post_journal_entry` tool.

## config/agent.yaml

```yaml
agent:
  name: invoice-reconciliation
  mode: act    # required -- ModeHook blocks every custom/MCP tool by name in chat/plan, regardless of
               # risk level, and that includes three_way_match; see doc 00 §5
tools:
  custom: [{module: finance_ext.tools}]   # post_journal_entry
mcp:
  servers:
    - command: python3               # stdio subprocess, co-located with koboi -- see "What you build" above
      args: ["/app/erp_mcp_server.py"]
sandbox:
  backend: restricted
server:
  allowed_modes: [chat, act]
  auth_required: true
  cors:
    allow_origins: ["http://localhost:3000"]  # the controller dashboard's origin
    expose_headers: ["X-Session-Id"]          # without this the browser can't read the session id across turns
```

`post_journal_entry`'s `DESTRUCTIVE` risk level, not a YAML flag, is what makes chat mode pause for approval
— the three `erp-mcp` tools always come in as `SAFE`. `allowed_modes` just says which modes a request may
ask for (`act` for the job, `chat` for the controller); `agent.mode: act` is the default a request gets when
it doesn't specify one, and it's what lets the controller's chat session actually call `three_way_match` and
`post_journal_entry` at all.

## Why it matters

Two lessons show up together here. First, koboi plugs into infrastructure Ledgerline already has instead of
every consumer writing its own ERP wrapper — `erp-mcp` exists because other internal tools want the same read
access, and koboi is just one more client, an `mcp.servers` entry instead of custom API glue. Second, and the
more interesting design call: keeping `post_journal_entry` local instead of pulling it in over MCP too is
deliberate, not a caveat — MCP tools are always `SAFE`, so the one write that matters stays local,
`DESTRUCTIVE`, and approval-gated, while everything read-only rides on shared infrastructure. Shared read
access plus a protected write path is the realistic shape of most finance integrations.

## Open questions

- **Review queue storage** — a table in the existing ERP, or a small store `erp-mcp` owns? Affects whether
  `three_way_match` needs its own schema.
- **Audit-to-session correlation** — tying an audit row back to the chat session or job run that produced it
  needs a request ID in the hook context; worth confirming where that comes from.
- **Dual sign-off above a dollar threshold** — koboi's built-in approval is single-approver; a second
  approver above some amount would need custom approval-handler logic, not yet designed.
