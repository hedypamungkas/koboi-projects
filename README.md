# koboi-use-cases

Six real-world businesses, six full-stack apps, one AI agent framework: [`koboi-agent`](../koboi-agent).

Each use case here is a complete app — web frontend, self-hosted backend (Docker), and a small layer of
business logic — built by **consuming** koboi-agent as a dependency, never forking it. Together they make one
point: **koboi is easy to start with what's built in, and just as easy for an enterprise to extend when the
business needs something custom.** Same codebase, both stories.

## Start here

[`docs/00-consuming-koboi-server.md`](docs/00-consuming-koboi-server.md) — the shared contract every app
below builds on: how the frontend talks to koboi, chat vs. background jobs, what's built in vs. what you
write, and the Docker setup. Read this first; the sector docs only cover what's different.

## The six use cases

| # | Business | What the app does | Out of the box | Custom |
|---|---|---|---|---|
| 1 | [E-commerce support](docs/01-ecommerce-retail-support.md) | Storefront chat answers order/return questions, processes simple refunds | RAG, chat, prompt-injection guard + rate limit (2 YAML lines) | Order lookup, refund tool with human approval |
| 2 | [HR screening](docs/02-hr-recruiting-screening.md) | Screens resumes overnight into a ranked shortlist for recruiters | Background jobs | ATS lookup, scoring, audit-trail hook |
| 3 | [Finance reconciliation](docs/03-finance-invoice-reconciliation.md) | Matches invoices to POs overnight; controller approves postings each morning | Jobs + chat, MCP client (connects to the company's own ERP server) | Ledger-posting tool kept local so it stays approval-gated |
| 4 | [Healthcare intake](docs/04-healthcare-patient-intake.md) | Pre-visit chat checks symptoms against clinical protocols, flags urgent cases | RAG, chat, secret-redacting output filter | PHI-redaction guardrail, escalation flag, context strategy that protects the first message |
| 5 | [Legal contract review](docs/05-legal-contract-review.md) | First-pass redlining against a firm's clause playbook | Jobs + chat, Skills (playbook is Markdown, no retriever code) | Draft-only redline tool, novel-clause flag |
| 6 | [Real estate](docs/06-real-estate-property-management.md) | Buyer chat on listings + nightly draft descriptions and lead follow-ups | Jobs + chat, `delegate_tasks` fan-out for batch drafting | Property lookup, drafting tools |

Every app follows the same shape: a web UI, one koboi container, and a small Python package with the
business-specific tools. No two lean on the same koboi capability the same way — RAG, guardrails, MCP,
Skills, and parallel task fan-out each show up where they're the natural fit, not everywhere at once.

## Status

These are design specs — architecture, `config.yaml`, code skeletons, Docker setup, frontend sketch — not
yet built. Each doc ends with the open questions worth settling before writing real code.
