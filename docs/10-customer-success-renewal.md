# 10 -- SaaS Customer Success: Account Health &amp; Renewal (proactive memory + self-consistency)

> Design doc for [`../customer-success/`](../customer-success/). Read [`00-consuming-koboi-server.md`](00-consuming-koboi-server.md) first.

## The business

A B2B SaaS company's customer-success team watches account health signals (usage trends, support load,
sentiment, renewal proximity) and turns them into the right action: maintain, check in, escalate, or run a
QBR. The hard parts are (a) remembering each account's relationship history without re-asking, (b) not
over-reacting to a single noisy risk score, and (c) keeping human control over customer-facing copy.

## The app

Single-agent (the only one of the four new use cases that isn't orchestrated):

- **CSM chat** (`POST /v1/chat/stream`) -- "score churn risk for ACC-7702" → a structured, consensus-voted
  risk assessment; "draft outreach" → a `MODERATE` draft that pauses for CSM approval.
- **Weekly account-review job** (`POST /v1/jobs`) -- assesses every tracked account and flags at-risk ones
  to their CSM; HMAC-POSTs the result to the CRM via `jobs.webhooks`.

## Built in vs. custom

| Need | Built in (YAML) | Custom (`cs_ext`) |
|---|---|---|
| Remember account history across visits | `memory.proactive` (extract/recall/core-block) | -- |
| Don't trust one noisy risk score | `self_healing.self_consistency` (N-sample vote) | -- |
| Approve customer-facing copy | `MODERATE` tool → `pending_approval` + `/approve` | -- |
| Generate a QBR image | `media` (image) | -- |
| Hand at-risk accounts to the CSM | `transfer_to_human`/`flag_at_risk` + `handover.digest` | -- |
| Keep the rationale faithful | `grounding_check` | -- |
| Notify the CRM on job completion | `jobs.webhooks` | -- |
| Read signals, score risk, draft, flag | -- | `fetch_account_health`, `score_churn_risk`, `draft_outreach`, `flag_at_risk` |

## Why single-agent

Self-consistency votes the terminal structured answer on the single-agent loop; `pending_approval` only
surfaces there too. Orchestration-mode use cases (UC1-3) can't host either, so they route human judgment
through `transfer_to_human` + `policy.rules`. This app deliberately stays single-agent to compose HITL +
self-consistency + proactive memory -- the three features that need that path.

## Status

**Live-verified (2026-07-18)** via the shared gateway: churn-risk assessment returns the structured JSON
schema; `draft_outreach` HITL pauses (`pending_approval`), resolves via `/approve`, and saves the draft.
`self_consistency` and `media` are wired but weren't the focus of the live run. `media` uses the offline
`mock` image provider; `self_consistency` aggregates the prompt-instructed structured risk JSON.
