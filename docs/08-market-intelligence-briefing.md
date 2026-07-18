# 08 -- Corporate Strategy: Cited Competitive-Intelligence Briefings (deep_research)

> Design doc for [`../market-intel/`](../market-intel/). Read [`00-consuming-koboi-server.md`](00-consuming-koboi-server.md) first.

## The business

**Northwind Strategy** -- fictional corporate-strategy team needing a **recurring, cited** read on a
competitor watchlist (pricing, launches, earnings, personnel, regulatory). The worst failure mode for
strategy work is unsourced claims that don't hold up.

## The app

- **Analyst chat** (`POST /v1/chat/stream`) -- "research Acme Cloud this quarter" → a cited deep-research
  brief, streamed back.
- **Weekly brief job** (`POST /v1/jobs`, UI button) -- research every tracked competitor, synthesize one
  cited brief, HMAC-POST it to the wiki/Slack receiver.

The engine is **deep_research orchestration**: the LLM *plans the research workflow per query*
(plan → search → fetch → coverage → drill deeper → synthesize), with caps and a coverage threshold.

## Built in vs. custom

| Need | Built in (YAML) | Custom |
|---|---|---|
| Plan + run multi-source web research | `deep_research` + `websearch` | -- |
| Cite every claim, stop at coverage | `research:` (citations, coverage_threshold, caps) | -- |
| Refuse to fabricate when sources are thin | engine + `self_healing`/grounding | -- |
| Hand off when coverage can't be reached | `handover` | -- |
| Notify the wiki on completion | `jobs.webhooks` | -- |

**No custom code** -- this is a config-only app. An earlier draft had `get_tracked_competitors` /
`publish_brief` tools, but a live run showed deep_research only injects `web_search`/`web_fetch` into
research nodes, so custom tools were never invoked and were removed. The watchlist is in the system prompt;
the brief is the job result.

## Why mock by default

Live research needs a search API key. The `websearch.search.provider: mock` default runs the whole loop
offline (scripted/empty results) -- which also neatly demonstrates the hallucination guard (the engine
reports "no results found" with citations rather than inventing). Flip to `firecrawl`/`brave` + a key for
real research (slow -- several minutes per brief).

## Status

**Live-verified (2026-07-18)** via the shared gateway: `mock` completed a full cited brief (honest
empty-results report); `firecrawl` did real research (31 searches, 32 fetches, 5 sources). Deep research is
inherently slow; the job timeout is 1800s.
