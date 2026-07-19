# koboi-use-cases

Ten real-world businesses, ten full-stack apps, one AI agent framework: [`koboi-agent`](../koboi-agent).

Each use case here is a complete app — web frontend, self-hosted backend (Docker), and a small layer of
business logic — built by **consuming** koboi-agent as a dependency, never forking it. Together they make one
point: **koboi is easy to start with what's built in, and just as easy for an enterprise to extend when the
business needs something custom.** Same codebase, both stories.

## Quickstart (one command)

The fastest way to try any of the ten apps. A small wizard checks Docker, clones this repo, writes the
`.env` (asking for your OpenAI/gateway key), builds, starts, and prints the URL — then you just use the app
in your browser. Requires **Docker** ([Docker Desktop](https://docs.docker.com/desktop/) for macOS/Windows,
or Docker Engine + the compose plugin on Linux).

**macOS / Linux** (run from anywhere):

```sh
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/quickstart.sh | bash
```

**Windows** (PowerShell — the launcher finds WSL2 or Git Bash for you):

```powershell
irm https://raw.githubusercontent.com/<owner>/<repo>/main/quickstart.ps1 | iex
```

> Replace `<owner>/<repo>` with this repo's path once published. Until then, run the local copy:
> `bash quickstart.sh` (macOS/Linux/Git Bash/WSL) or
> `powershell -ExecutionPolicy Bypass -File quickstart.ps1` (Windows).

The wizard picks a use case, shows live build/startup progress, waits for the health check, and prints the
Web UI + API URLs. It also runs headlessly for automation:

```sh
OPENAI_API_KEY=sk-... bash quickstart.sh --project hr-screening --yes   # one project, no prompts
```

Other commands: `--list` (projects + ports), `--status` (what's running + health),
`--logs <project>`, `--down <project> [--purge]`, `--update`, `--help`.

Prefer the manual path? Each project directory has its own `README.md` with exact `docker compose` +
`curl` smoke-test steps, and [`TEST.md`](TEST.md) is the full layered reproduction runbook.

## Start here

[`docs/00-consuming-koboi-server.md`](docs/00-consuming-koboi-server.md) — the shared contract every app
below builds on: how the frontend talks to koboi, chat vs. background jobs, what's built in vs. what you
write, and the Docker setup. Read this first; the sector docs only cover what's different.

## The ten use cases

| # | Business | What the app does | Out of the box | Custom | Run it |
|---|---|---|---|---|---|
| 1 | E-commerce support | Storefront chat answers order/return questions, processes simple refunds | RAG, chat, prompt-injection guard + rate limit (2 YAML lines) | Order lookup, refund tool with human approval | [`ecommerce-support/`](ecommerce-support/) · [design doc](docs/01-ecommerce-retail-support.md) |
| 2 | HR screening | Screens resumes overnight into a ranked shortlist for recruiters | Background jobs | ATS lookup, scoring, audit-trail hook | [`hr-screening/`](hr-screening/) · [design doc](docs/02-hr-recruiting-screening.md) |
| 3 | Finance reconciliation | Matches invoices to POs overnight; controller approves postings each morning | Jobs + chat, MCP client (connects to the company's own ERP server) | Ledger-posting tool kept local so it stays approval-gated | [`finance-reconciliation/`](finance-reconciliation/) · [design doc](docs/03-finance-invoice-reconciliation.md) |
| 4 | Healthcare intake | Pre-visit chat checks symptoms against clinical protocols, flags urgent cases | RAG, chat, secret-redacting output filter | PHI-redaction guardrail, escalation flag, context strategy that protects the first message | [`healthcare-intake/`](healthcare-intake/) · [design doc](docs/04-healthcare-patient-intake.md) |
| 5 | Legal contract review | First-pass redlining against a firm's clause playbook | Jobs + chat, Skills (playbook is Markdown, no retriever code) | Draft-only redline tool, novel-clause flag | [`legal-contract-review/`](legal-contract-review/) · [design doc](docs/05-legal-contract-review.md) |
| 6 | Real estate | Buyer chat on listings + nightly draft descriptions and lead follow-ups | Jobs + chat, `delegate_tasks` fan-out for batch drafting | Property lookup, drafting tools | [`real-estate/`](real-estate/) · [design doc](docs/06-real-estate-property-management.md) |
| 7 | Insurance claims triage | P&amp;C FNOL triage: checks coverage, estimates damage, screens fraud, routes each claim | **Self-healing** + handover, policy rules, job webhooks | Claim lookup, repair estimate, fraud screen, recommendation tools | [`insurance-claims/`](insurance-claims/) · [design doc](docs/07-insurance-claims-triage.md) |
| 8 | Market intelligence | Recurring **cited competitive briefs** from live web research | **Deep-research orchestration**, web search/fetch, handover, job webhooks | _config-only (no custom code)_ | [`market-intel/`](market-intel/) · [design doc](docs/08-market-intelligence-briefing.md) |
| 9 | Employee concierge (A2A) | Routes employee requests to separate **IT / Facilities department agents** | **Cross-instance A2A** (`call_peer_agent`), command hooks, policy rules, proactive memory, handover | IT + Facilities tool sets; external ticket-script hook | [`employee-concierge/`](employee-concierge/) · [design doc](docs/09-employee-concierge-a2a.md) |
| 10 | Customer success | Account health, churn-risk scoring, renewal outreach | **Proactive memory, self-consistency**, multimodal, handover, job webhooks | Health fetch, risk score, outreach draft (HITL), at-risk flag | [`customer-success/`](customer-success/) · [design doc](docs/10-customer-success-renewal.md) |

Every app follows the same shape: a web UI, a koboi container (or three, for the A2A concierge), and a
small Python package with the business-specific tools (market-intel is the exception — config-only, no
custom code, because deep-research does the work). The first six exercise koboi's foundational
capabilities — RAG, guardrails, MCP, Skills, and parallel task fan-out — each where it's the natural fit.
**Use cases 7-10 adopt the newer 0.18 surface none of the first six touch:** deep-research orchestration,
cross-instance A2A, self-healing, human handover, policy rules, proactive memory, self-consistency,
multimodal generation, and job webhooks. A structural split worth knowing: **only 8 is orchestrated**
(`deep_research`, which injects web tools into research nodes — so human judgment enters via `handover`,
not an approval card); **7 and 10 are single-agent** (7's tools+RAG+self-healing/handover/policy all fire
on that path; 10 is the one place an in-chat approval card, self-consistency, and proactive memory
compose); **9 is A2A** — a single-agent front door that calls separate peer instances over HTTP.

## Status

**All ten are built, each installing `koboi-agent[api]==0.18.2` straight from PyPI** — no git
checkout, no local wheel, nothing vendored into this repo. Every project directory has its own
`docker-compose.yml`, `README.md` with exact run/smoke-test steps, and a "Deviations" section documenting
where the real `koboi-agent` behavior differed from the design doc's sketch (a handful of real gaps only
surfaced by actually running the code — see each README).

The first six (1-6) are real-LLM-verified end-to-end against 0.18.2. **The four new ones (7-10) are also
real-LLM-verified end-to-end (2026-07-18, shared gateway)** — and building them surfaced three real koboi
0.18 gaps, each fixed and documented in the relevant README: (a) orchestration `agents[].system_prompt` /
`rag` / `tools` are dead config (the local sub-agent builder only knows four hardcoded demo agents;
`_build_agent_from_def` is uncalled) — so 7 was redesigned single-agent, leaving 8 (deep_research) as the
orchestration showcase; (b) A2A-enabled servers force auth on (a Bearer is mandatory with outbound peers);
(c) `peer_invoke` on an `act`-mode agent requires `sandbox.backend: restricted`. Each project README has the
exact smoke-test commands and a "Deviations" section.

Quick start for any one of them:
```bash
cd <project-dir>   # e.g. ecommerce-support
docker compose build
docker compose up -d
# see that project's README for the exact smoke-test curl commands and expected output
```
