# E-commerce & Retail — Tier-1 Customer Support Deflection

> **Status:** Design one-pager (not yet built) · **Date:** 2026-07-03
> **Reference:** [`docs/00-consuming-koboi-server.md`](00-consuming-koboi-server.md) — read first for endpoints,
> auth, chat-vs-job modes, SSE shape, and extension points. This doc only covers what's specific to this sector.

## Business problem

A mid-size online retailer wants an AI agent embedded in their live chat widget to deflect tier-1 support
volume — order status, shipping ETA, return/refund eligibility, product questions — down to a human agent
only for exceptions. The one hard constraint: **nothing that moves money happens without a human or policy
sign-off.** Refunds and returns must be safe by construction, not by prompt discipline.

## 1. Context & assumptions

| | |
|---|---|
| Customer | Mid-size commerce backend (Shopify or a comparable OMS/e-commerce platform) |
| What's dynamic (fetched live) | Order status, shipment tracking, return eligibility — pulled from the retailer's existing OMS/Shopify API at tool-call time. koboi holds no order data itself. |
| What's static (RAG corpus) | Product catalog descriptions, shipping policy, return/refund policy, FAQ — ingested as documents, retrieved via RAG. |
| Execution mode | Interactive chat, `POST /v1/chat/stream` — **not** `/v1/jobs**. A human customer is present for the whole turn, and jobs have no HITL support (per doc 00 §1), which rules them out for anything touching the refund tool. |
| `mode` | `chat` or `act` per turn (see §4 config) — `plan`/`auto` add no value in a support-chat context and are omitted from `allowed_modes` to shrink the input surface. |
| Session lifetime | One session per chat-widget conversation; ends when the customer closes the widget or a human agent takes over. |

## 2. Architecture

```
                    ┌──────────────────┐
                    │  Chat widget (web)│
                    └────────┬─────────┘
                             │ POST /v1/chat/stream (SSE)
                             ▼
                 ┌───────────────────────┐
                 │   koboi server (1 node)│
                 │  config/agent.yaml     │
                 └───┬──────────┬─────────┘
                     │          │
        ┌────────────┘          └───────────────┐
        ▼                                        ▼
┌──────────────────────┐              ┌───────────────────────┐
│ RAG retriever          │              │ ecommerce_ext.tools    │
│ (product/policy docs)  │              │  - lookup_order        │
│ builtin or custom      │              │  - check_return_       │
│ vector store — open Q  │              │    eligibility         │
└──────────────────────┘              │  - initiate_refund      │
                                        │    (RiskLevel.DESTRUCTIVE)
                                        └──────────┬─────────────┘
                                                   │ HTTPS
                                                   ▼
                                        ┌───────────────────────┐
                                        │ Retailer's OMS /       │
                                        │ Shopify Admin API      │
                                        └───────────────────────┘

Refund path only:
  initiate_refund called → PolicyHook/threshold check → pending_approval SSE event
  → human agent reviews in back-office UI → POST /v1/sessions/{id}/approve
  → tool executes against OMS → refund posted
```

`lookup_order` and `check_return_eligibility` are `SAFE` and execute immediately — no approval gate. Every
refund attempt, regardless of amount, produces at minimum a `pending_approval` event; the approval handler
decides whether it's auto-resolved (small, low-risk) or requires a real human click (see §5).

## 3. Project structure

```
ecommerce-support/
├── pyproject.toml
├── config/
│   └── agent.yaml
├── src/
│   └── ecommerce_ext/
│       ├── __init__.py
│       ├── tools.py        # lookup_order, check_return_eligibility, initiate_refund
│       └── hooks.py        # audit log of refund attempts (PRE_TOOL_USE / POST_TOOL_USE)
├── data/
│   └── seed/                # policy.md, shipping.md, returns.md, faq.md — the RAG corpus
├── Dockerfile
└── tests/
    └── test_tools.py
```

`pyproject.toml` declares `koboi-agent[api] @ git+https://.../koboi-agent.git` as a dependency and installs
`ecommerce_ext` as an editable package (`pip install -e .`) so `tools.custom: [{module: ecommerce_ext.tools}]`
in the YAML can import it.

## 4. Key code skeletons

### (a) Safe read-only tools

```python
# src/ecommerce_ext/tools.py
from koboi.tools.registry import tool
from koboi.types import RiskLevel

@tool(
    name="lookup_order",
    description="Look up an order's status, items, and shipping ETA by order number or customer email.",
    parameters={
        "type": "object",
        "properties": {
            "order_id": {"type": "string", "description": "Order number, e.g. #1042"},
            "customer_email": {"type": "string", "description": "Fallback lookup key if order_id unknown"},
        },
        "required": [],
    },
    risk_level=RiskLevel.SAFE,
)
async def lookup_order(order_id: str = "", customer_email: str = "") -> str:
    # call retailer's OMS/Shopify Admin API, return a compact JSON-as-string summary
    ...

@tool(
    name="check_return_eligibility",
    description="Check whether an order/item is within the return window and eligible per policy.",
    parameters={
        "type": "object",
        "properties": {
            "order_id": {"type": "string"},
            "line_item_id": {"type": "string"},
        },
        "required": ["order_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def check_return_eligibility(order_id: str, line_item_id: str = "") -> str:
    ...
```

### (b) Destructive tool — the refund

```python
@tool(
    name="initiate_refund",
    description=(
        "Initiate a refund for an order or line item. This is a money-moving action and "
        "requires approval before it takes effect."
    ),
    parameters={
        "type": "object",
        "properties": {
            "order_id": {"type": "string"},
            "amount_cents": {"type": "integer", "description": "Refund amount in cents"},
            "reason": {"type": "string"},
        },
        "required": ["order_id", "amount_cents", "reason"],
    },
    risk_level=RiskLevel.DESTRUCTIVE,
)
async def initiate_refund(order_id: str, amount_cents: int, reason: str) -> str:
    # only reached after approval resolves — calls OMS refund endpoint
    ...
```

### (c) `config/agent.yaml` (relevant excerpts)

```yaml
mode: chat

tools:
  builtin: [memory]           # no filesystem/shell — not needed for a support bot
  custom:
    - module: ecommerce_ext.tools

rag:
  retriever: hybrid            # koboi builtin; swap to a custom_modules entry if a dedicated vector DB is added
  chunking: paragraph
  top_k: 8
  corpus_path: data/seed/

server:
  auth_required: true
  allowed_modes: [chat, act]
  limits:
    max_iterations_cap: 12
```

`tools.custom` and `rag.retriever` follow the exact registration contract in doc 00 §5 — no koboi core code
is touched.

## 5. Approval / guardrail design

`initiate_refund` is `RiskLevel.DESTRUCTIVE`, which is koboi's built-in trigger for the HITL flow described in
doc 00 §1/§2: the tool call surfaces as a `pending_approval` SSE event instead of executing immediately, and
the widget's backing service must call `POST /v1/sessions/{id}/approve` to let it proceed (or reject it).

Concretely:

- **Below-threshold refunds** (e.g. under $50, retailer-configurable): the back-office approval UI can
  auto-approve via a policy check in a custom `ApprovalHandler.should_approve(tool_name, arguments, risk_level)`
  override (doc 00 §5) — e.g. `if tool_name == "initiate_refund" and arguments["amount_cents"] < 5000: return True`.
- **Above-threshold refunds**: `should_approve` returns `False`/defers, the `pending_approval` event sits until
  a human support agent reviews it in a back-office queue and calls the approve endpoint explicitly.
- This is the same seam koboi uses for its own `AutonomousApprovalHandler` in job mode (doc 00 §1) — we are
  not inventing a new mechanism, just supplying sector-specific threshold logic.
- `hooks.py` registers a `PRE_TOOL_USE`/`POST_TOOL_USE` hook (business-tier priority, 40-59 per koboi's hook
  ordering) that writes an audit record of every refund attempt and its resolution, independent of whether it
  was auto- or human-approved — this is the compliance trail a retailer's finance team will ask for.

## 6. Deployment

Single self-hosted node, exactly as in doc 00 §6: `pip install "koboi-agent[api] @ git+..."`, `koboi serve
config/agent.yaml --host 0.0.0.0 --port 8000`, `/data` volume for `koboi_memory.db*` + `keys.json` + session
workdirs. No sector-specific deployment wrinkles — nothing here changes the single-node, non-concurrent
constraint called out in doc 00.

## 7. What this demonstrates

This sector is the clearest illustration of koboi's **interactive chat + HITL** story: a live customer-facing
conversation (`/v1/chat/stream`) that reads freely via `SAFE` tools and RAG, but hard-stops any money-moving
action behind `RiskLevel.DESTRUCTIVE` + the `pending_approval`/`approve` handshake. It also shows the
RAG-plus-live-API pattern most support bots need — static policy knowledge blended with a real-time system of
record — without requiring any change to koboi core.

## 8. Open questions

- **Vector store choice**: koboi's builtin `hybrid` retriever (keyword + semantic, file-based corpus) is
  probably sufficient for a product/policy doc set of this size — but if the catalog is large or changes
  frequently, a dedicated vector DB via a custom `@register_retriever` may be worth it. Doc 00 doesn't specify
  a default vector DB, so this needs a decision once corpus size/update frequency is known.
- **Refund auto-approve threshold**: what dollar amount (if any) should bypass human review, and does it vary
  by customer tier/order value/return reason? This is a policy decision for the retailer's finance/CS leads,
  not a technical one.
- **OMS/Shopify API scope**: does the support bot get a read-write API key with refund permission, or does
  `initiate_refund` write to a staging/approval queue inside the retailer's own system instead of calling
  Shopify directly? Affects whether koboi's approval gate is the *only* gate or a second one in front of an
  existing internal approval system.
- **Escalation to human handoff**: doc 00 has no notion of "hand this chat session to a live agent." Is that
  handled entirely in the chat-widget layer (outside koboi), or does it need a custom tool/hook that flags a
  session for takeover?
- **PII in chat transcripts**: order lookups will surface customer name/address/email in the SSE stream and in
  `koboi_memory.db`. Does the retailer need a redaction guardrail or data-retention policy beyond what doc 00
  covers (no PII handling is described there)?
