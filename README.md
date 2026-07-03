# koboi-use-cases

Sector-specific example projects showing how a business **consumes** [`koboi-agent`](../koboi-agent)
as a self-hosted, installed dependency — not a fork. Each use case is a design one-pager: architecture,
`config.yaml`, and the specific tool/hook/retriever/guardrail code a consumer would write.

This is a **separate repository** from `koboi-agent`. Nothing here modifies koboi's core; every example
extends it through the public extension seams (custom tools, custom retrievers, hooks, guardrails) documented
in [`docs/00-consuming-koboi-server.md`](docs/00-consuming-koboi-server.md).

## Start here

- [`docs/00-consuming-koboi-server.md`](docs/00-consuming-koboi-server.md) — the shared contract: endpoints,
  auth, chat-vs-job modes, SSE event shape, extension points, deployment shape. Read this first — every
  sector doc below assumes it.

## Sector use cases

| # | Sector | Business problem | koboi features showcased |
|---|---|---|---|
| 1 | [E-commerce & Retail Support](docs/01-ecommerce-retail-support.md) | Deflect tier-1 support tickets (order status, returns, product Q&A) | Interactive chat + RAG (product/policy docs) + `DESTRUCTIVE`-gated refund tool + HITL approval |
| 2 | [HR & Recruiting](docs/02-hr-recruiting-screening.md) | Screen hundreds of resumes against a role, consistently | Autonomous jobs (batch) + custom ATS tool + audit hook for bias/compliance review |
| 3 | [Finance & Accounting Ops](docs/03-finance-invoice-reconciliation.md) | Match/reconcile vendor invoices against POs at month-end | `DESTRUCTIVE` tools (post journal entries) + maker-checker `ApprovalHandler` + `PRE/POST_TOOL_USE` audit trail |
| 4 | [Healthcare Patient Intake](docs/04-healthcare-patient-intake.md) | Pre-visit intake & triage against clinical protocols | RAG over clinical guidelines + PII-redaction guardrail + `sandbox: restricted` |
| 5 | [Legal Contract Review](docs/05-legal-contract-review.md) | First-pass redlining against a clause playbook | Custom retriever over clause library + `policy.rules` engine + approval gate before finalizing |
| 6 | [Real Estate & Property Management](docs/06-real-estate-property-management.md) | Answer buyer inquiries + nightly listing/lead automation | Chat (buyer Q&A) *and* jobs (nightly batch) in the same config + custom CRM tool |

## What "consuming koboi" means in practice

Each sector's project is a small installable Python package (`src/<sector>_ext/`) plus a `config.yaml` that
points at it. You `pip install "koboi-agent[api] @ git+..."`, `pip install -e .` your own package, and run
`koboi serve config.yaml`. koboi never needs to be forked — every business-specific behavior (tools, RAG
backend, approval policy, audit hooks) lives in your package and is loaded via config or entry-points.

## Status

Design one-pagers (architecture + config + code skeletons), not yet built/deployed. See each doc's
"Open questions" section for what needs a decision before implementation starts.
