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

| # | Business | What the app does | Out of the box | Custom | Run it |
|---|---|---|---|---|---|
| 1 | E-commerce support | Storefront chat answers order/return questions, processes simple refunds | RAG, chat, prompt-injection guard + rate limit (2 YAML lines) | Order lookup, refund tool with human approval | [`ecommerce-support/`](ecommerce-support/) · [design doc](docs/01-ecommerce-retail-support.md) |
| 2 | HR screening | Screens resumes overnight into a ranked shortlist for recruiters | Background jobs | ATS lookup, scoring, audit-trail hook | [`hr-screening/`](hr-screening/) · [design doc](docs/02-hr-recruiting-screening.md) |
| 3 | Finance reconciliation | Matches invoices to POs overnight; controller approves postings each morning | Jobs + chat, MCP client (connects to the company's own ERP server) | Ledger-posting tool kept local so it stays approval-gated | [`finance-reconciliation/`](finance-reconciliation/) · [design doc](docs/03-finance-invoice-reconciliation.md) |
| 4 | Healthcare intake | Pre-visit chat checks symptoms against clinical protocols, flags urgent cases | RAG, chat, secret-redacting output filter | PHI-redaction guardrail, escalation flag, context strategy that protects the first message | [`healthcare-intake/`](healthcare-intake/) · [design doc](docs/04-healthcare-patient-intake.md) |
| 5 | Legal contract review | First-pass redlining against a firm's clause playbook | Jobs + chat, Skills (playbook is Markdown, no retriever code) | Draft-only redline tool, novel-clause flag | [`legal-contract-review/`](legal-contract-review/) · [design doc](docs/05-legal-contract-review.md) |
| 6 | Real estate | Buyer chat on listings + nightly draft descriptions and lead follow-ups | Jobs + chat, `delegate_tasks` fan-out for batch drafting | Property lookup, drafting tools | [`real-estate/`](real-estate/) · [design doc](docs/06-real-estate-property-management.md) |

Every app follows the same shape: a web UI, one koboi container, and a small Python package with the
business-specific tools. No two lean on the same koboi capability the same way — RAG, guardrails, MCP,
Skills, and parallel task fan-out each show up where they're the natural fit, not everywhere at once.

## Status

**All six are built and running, each installing `koboi-agent[api]==0.18.2` straight from PyPI** — no git
checkout, no local wheel, nothing vendored into this repo. Every project directory has its own
`docker-compose.yml`, `README.md` with exact run/smoke-test steps, and a "Deviations" section documenting
where the real `koboi-agent` behavior differed from the design doc's sketch (a handful of real gaps only
surfaced by actually running the code — see each README).

Quick start for any one of them:
```bash
cd <project-dir>   # e.g. ecommerce-support
docker compose build
docker compose up -d
# see that project's README for the exact smoke-test curl commands and expected output
```
