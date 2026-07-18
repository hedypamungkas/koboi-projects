# 07 -- Insurance: P&amp;C Claims Triage (self-healing + handover + policy)

> Design doc for [`../insurance-claims/`](../insurance-claims/). Read [`00-consuming-koboi-server.md`](00-consuming-koboi-server.md) first.

## The business

**Beacon Mutual** -- a fictional property &amp; casualty carrier. First-notice-of-loss (FNOL) auto claims
arrive around the clock and need a fast, consistent first pass: is the loss covered? roughly how much is
the repair? are there fraud signals? and -- the decision that matters -- **does this route to a routine
settlement recommendation, or to a human adjuster?**

## The app

A **single-agent** triage (see "Why single-agent" below) with two entry points:

- **Adjuster chat** (`POST /v1/chat/stream`) -- "triage CLM-501" → the agent looks up the claim, checks
  coverage against the policy RAG, estimates repair cost, screens fraud, then records a recommendation
  (simple/low-value) or hands off to a human (high-value/complex/fraud).
- **Autonomous triage job** (`POST /v1/jobs`) -- the nightly FNOL batch, same flow unattended; fires a
  webhook on completion.

## Built in vs. custom

| Need | Built in (YAML) | Custom (`claims_ext`) |
|---|---|---|
| Re-check repair math | `self_healing.tool_verification` (`calculate`) | -- |
| Retry on tool errors / graceful degrade | `self_healing` | -- |
| Route to a human with a warm summary | `transfer_to_human` + `handover.digest` | -- |
| Block total-loss auto-recommend | `policy.rules` (`deny`) | -- |
| Notify the claims system on job completion | `jobs.webhooks` | -- |
| Read claim, price repair, score fraud, record rec | -- | `lookup_claim`, `estimate_repair_cost`, `screen_fraud`, `record_recommendation` |

## Why single-agent, not a DAG

The original sketch was a multi-agent DAG. In koboi 0.18.2 the orchestrator's local sub-agent builder only
knows four hardcoded demo agents (`hr`/`sales`/`finance`/`general`) and falls back to `general` for
anything else; the config-aware builder (`_build_agent_from_def`) is dead code (zero callers), so
`orchestration.agents[].system_prompt`/`rag`/`tools` are ignored. A live DAG run confirmed nodes ran as
`general` with `tool_calls: null`. So the triage is one agent, where tools/RAG/self-healing/handover/policy
all genuinely fire. Orchestration is still showcased by `market-intel` (`deep_research`). See the runnable
README for the full finding.

## Status

**Live-verified (2026-07-18)** with a real LLM via the shared gateway: CLM-501 records a recommendation;
CLM-502 routes to `transfer_to_human`. `grounding_check` intentionally omitted (misapplied to a
tool-driven flow -- see README).
