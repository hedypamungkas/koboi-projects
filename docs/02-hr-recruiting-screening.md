# HR & Recruiting — Resume Screening at Scale

> See [`docs/00-consuming-koboi-server.md`](00-consuming-koboi-server.md) first — endpoints, auth, chat-vs-job
> modes, SSE shape, extension points, deployment shape. This doc only covers what's specific to resume
> screening.

## 1. Context & assumptions

- Resumes land either in an ATS (Greenhouse/Lever-style, via webhook) or as files in an S3/R2 bucket per
  requisition. A candidate resume + a job description (JD) with structured criteria (must-haves, nice-to-haves,
  years of experience) are the two inputs to a screening pass.
- This is a **batch/back-office** workload — nobody watches a chat window while resumes get screened. It maps
  to koboi's **autonomous job** mode (`POST /v1/jobs`, doc 00 §1), not `/v1/chat/stream`.
- Compliance requirement: screening must be **auditable and explainable** after the fact (EEOC / local
  bias-review expectations). No black-box rejections — every score needs a rationale trail.
- The agent produces a **ranked recommendation**, not a hiring decision. A human recruiter makes the actual
  advance/reject call (§5).

### Design choice: one job per resume, not one job per batch

| | One job per resume (chosen) | One job per batch |
|---|---|---|
| Failure isolation | A bad PDF or flaky ATS write fails only *that* candidate's job (`failed`, retriable) | One malformed resume can fail/stall the whole batch's job |
| Concurrency | Fits `jobs.max_concurrent` / `jobs.per_tenant_max` directly | Agent must loop over N resumes inside one long-running job; one `timeout_seconds` covers the whole batch |
| Audit granularity | 1 `trace_id` / job per candidate — clean 1:1 audit mapping | Sub-job tracing would have to be invented |
| Polling/UX | Recruiter tooling polls `GET /v1/jobs/{id}` per candidate as they arrive | Must wait for/parse the whole batch's partial state |

One job per resume wins on isolation and auditability — the two things this sector cares about most. The
webhook/cron trigger (§6) submits one job per new resume; `jobs.max_concurrent` and `jobs.per_tenant_max`
(real config keys under `jobs:`) bound concurrency so a burst of 300 resumes doesn't starve other tenants on
the same instance.

## 2. Architecture

```
ATS webhook / S3 event         hr-screening submitter          koboi server (self-hosted)
or nightly cron sweep   ─────▶ POST /v1/jobs                ─▶ AutonomousApprovalHandler auto-approves
                                { message: "screen resume       tool calls inside mandatory
                                  <id> for req <req_id>",       sandbox.backend=restricted
                                  session_id: <req_id>,               │
                                  mode: "act" }                       ▼
                                     │                          fetch_resume(resume_id) → ATS API / S3 GET
                                     │ 202 Accepted, job_id            │
                                     │                                ▼
                                     │                          RAG retrieve: JD + rubric (optional, see below)
                                     │                                │
                                     │                                ▼
                                     │                          LLM scores resume against criteria
                                     │                                │
                                     │                                ▼
                                     │                          score_candidate(id, score, rationale, gaps)
                                     │                             │        │
                                     │                             │        ▼
                                     │                             │  POST_TOOL_USE audit hook
                                     │                             │  → append-only audit store
                                     │                             ▼
                                     │                       ATS "review queue" field / queue table
                                     ▼
                     GET /v1/jobs/{id} (poll) or /v1/jobs/{id}/stream (SSE tail)
                                     │
                                     ▼
                     Recruiter reviews ranked shortlist + rationale, makes final call
```

RAG over the JD + rubric is optional: for one requisition, both fit directly in the system prompt (see
`config/agent.yaml`) with no retriever needed. It's worth wiring a retriever (`rag.retriever`, doc 00 §5) once
a company has many concurrent open reqs and wants the agent to pull the right JD/rubric chunk per job rather
than hardcoding one per config — flagged as an open question in §8.

## 3. Project structure

```
hr-recruiting-screening/
├── pyproject.toml
├── config/
│   └── agent.yaml
├── src/
│   └── hr_ext/
│       ├── __init__.py
│       ├── tools.py        # fetch_resume, score_candidate
│       ├── hooks.py        # audit hook registration (register_hook at import time)
│       └── entrypoint.py   # imports hooks.py, THEN starts the server
├── data/
│   └── seed/
│       ├── job_description.md
│       └── rubric.md
└── Dockerfile
```

## 4. Key code skeletons

### (a) `fetch_resume` tool — `src/hr_ext/tools.py` (SAFE)

```python
"""hr_ext/tools.py -- custom tools for resume screening."""

from koboi.tools.registry import tool
from koboi.types import RiskLevel


@tool(
    name="fetch_resume",
    description="Fetch a candidate's resume text and metadata by resume_id from the ATS/S3.",
    parameters={
        "type": "object",
        "properties": {"resume_id": {"type": "string", "description": "ATS resume/candidate id"}},
        "required": ["resume_id"],
    },
    risk_level=RiskLevel.SAFE,
    deps=["sandbox"],
)
async def fetch_resume(resume_id: str, _deps: dict) -> str:
    # _deps["sandbox"] is injected because this tool declares deps=["sandbox"];
    # use it if the fetch shells out or touches the per-job workdir.
    resume_text, metadata = await _ats_client_fetch(resume_id)
    return f"--- metadata ---\n{metadata}\n--- resume text ---\n{resume_text}"
```

### (b) `score_candidate` tool — `src/hr_ext/tools.py` (MODERATE)

```python
@tool(
    name="score_candidate",
    description=(
        "Record a structured screening score + rationale for a candidate against the "
        "current job description's criteria. Writes to the ATS review queue -- this "
        "recommends a ranking, it does NOT reject or advance the candidate."
    ),
    parameters={
        "type": "object",
        "properties": {
            "resume_id": {"type": "string"},
            "score": {"type": "number", "description": "0-100 fit score"},
            "rationale": {"type": "string", "description": "why this score -- cite specific JD criteria"},
            "gaps": {"type": "array", "items": {"type": "string"}, "description": "missing must-haves, if any"},
            "recommendation": {
                "type": "string",
                "enum": ["strong_match", "possible_match", "weak_match"],
                "description": "advisory only -- final call stays with a human recruiter",
            },
        },
        "required": ["resume_id", "score", "rationale", "recommendation"],
    },
    risk_level=RiskLevel.MODERATE,  # writes to the ATS, but never deletes/rejects -- not DESTRUCTIVE
)
async def score_candidate(resume_id: str, score: float, rationale: str, recommendation: str, gaps: list | None = None) -> str:
    await _ats_client_write_review_queue(resume_id, score, rationale, recommendation, gaps or [])
    return f"Recorded score={score} recommendation={recommendation} for resume_id={resume_id}"
```

`score_candidate` is `MODERATE`, not `DESTRUCTIVE` — it appends a recommendation to a review queue, never
deletes data or auto-rejects. Doc 00 §5 notes `DESTRUCTIVE` as the natural approval gate, but jobs run under
`AutonomousApprovalHandler` with no human-in-the-loop (doc 00 §1). Keeping this tool's blast radius to "write
a recommendation" — never "reject" or "send a rejection email" — is what makes autonomous-job mode acceptable
here at all; see §5.

### (c) Audit hook — `src/hr_ext/hooks.py`

```python
"""hr_ext/hooks.py -- append-only audit trail for every scoring decision.

Imported at app-entrypoint time (see entrypoint.py) so register_hook() runs
BEFORE KoboiAgent.from_config() builds the hook chain -- there is no YAML
custom_modules key for hooks (doc 00 SS5); this import-time side effect is
the only registration path.
"""

import json
import time

from koboi.hooks.chain import Hook, HookContext, HookEvent
from koboi.hooks.registry import HookEntry, register_hook


class ScoringAuditHook(Hook):
    """Logs every score_candidate call + result to an append-only file/table.

    Compliance safety net for bias/EEOC-style review: since jobs have no live
    approval step, this is the only place a tamper-evident record of "what
    did the agent decide and why" is captured.
    """

    def handles(self) -> list[HookEvent]:
        return [HookEvent.POST_TOOL_USE, HookEvent.SESSION_END]

    async def execute(self, ctx: HookContext) -> HookContext:
        if ctx.event == HookEvent.POST_TOOL_USE and ctx.tool_name == "score_candidate":
            record = {
                "ts": time.time(),
                "tool": ctx.tool_name,
                "arguments": ctx.tool_arguments,  # resume_id, score, rationale, gaps
                "result": ctx.tool_result,
                "iteration": ctx.iteration,
            }
            _append_only_write("audit/scoring_decisions.jsonl", json.dumps(record) + "\n")
        elif ctx.event == HookEvent.SESSION_END:
            _append_only_write("audit/session_end.jsonl", json.dumps({"ts": time.time()}) + "\n")
        return ctx


def _append_only_write(path: str, line: str) -> None:
    # Real implementation: write to a WORM bucket / immutable table, not a
    # local file the agent's own sandboxed process could edit later.
    with open(path, "a") as f:
        f.write(line)


register_hook(
    HookEntry(
        name="ScoringAuditHook",
        config_key="harness.hr_scoring_audit",  # informational only -- should_add doesn't gate on it
        should_add=lambda config, **kw: True,   # always on for this sector's config
        factory=lambda config, **kw: ScoringAuditHook(),
    )
)
```

```python
# src/hr_ext/entrypoint.py -- must import hooks BEFORE the server builds the agent
from hr_ext import hooks  # noqa: F401  (import-time side effect: register_hook)
from koboi.server.app import serve_app

serve_app("config/agent.yaml", host="0.0.0.0", port=8000)
```

`register_hook()`'s factory only receives the same runtime kwargs koboi's own registry passes
(`audit_trail`, `mode_manager`, `policy_engine`, `tool_registry`) — no channel for arbitrary custom kwargs, so
`ScoringAuditHook` takes no constructor args and reads what it needs from `ctx`.

### (d) `config/agent.yaml`

```yaml
agent:
  mode: act              # jobs never accept yolo regardless of this setting (doc 00 SS1)
  system_prompt: |
    You are a resume screener. Score the candidate against the job description
    and rubric below. Always call score_candidate exactly once per resume with
    a numeric score, a rationale citing specific criteria, and any gaps.
    Never claim to reject or advance a candidate -- your output is an advisory
    recommendation for a human recruiter.

llm:
  provider: openai
  model: gpt-4o-mini

tools:
  builtin: []             # no filesystem/shell/git needed -- ATS access is via custom tools only
  custom:
    - module: hr_ext.tools

sandbox:
  backend: restricted      # mandatory for job mode (doc 00 SS1) -- also just good practice here
  network: deny            # ATS access goes through the tools' own HTTP clients, not shell/network primitives

jobs:
  enabled: true
  max_concurrent: 10        # cap concurrent screening jobs on this single-node instance
  per_tenant_max: 5         # per API key (= per hiring team, doc 00 SS4) if teams share the instance
  timeout_seconds: 300      # one resume should score well within 5 minutes

server:
  allowed_modes: [chat, plan, act, auto]   # yolo is rejected for jobs unconditionally anyway
  limits:
    max_iterations_cap: 10                 # a screening pass shouldn't need many tool-call round-trips
```

## 5. Bias / compliance design

Jobs run through `AutonomousApprovalHandler`, meaning **no human sees or approves any individual scoring
decision as it happens** — the mandatory `sandbox.backend: restricted` (doc 00 §1) contains what tools can
touch, but says nothing about whether the agent's *judgment* was fair. That gap is what `ScoringAuditHook`
(§4c) covers:

- Every `score_candidate` call is captured verbatim — arguments and result — via `POST_TOOL_USE`, before
  anything downstream can summarize, truncate, or drop it.
- The record includes the full rationale text, not just the score, so a later bias review can check *why* a
  candidate scored low.
- The write path is a hook, not application code the agent could route around — it fires for every job run
  against this config, no code path skips it.

**The agent must never be allowed to auto-reject.** `score_candidate`'s `recommendation` enum
(`strong_match`/`possible_match`/`weak_match`) is advisory language, not a status transition — it writes to a
*review queue* field, not a `status: rejected` field. Two reasons:

1. **No human-in-the-loop exists at the point of decision** (unlike chat, doc 00 §1) — the only safety net is
   the audit hook, which is after-the-fact. An irreversible auto-reject with no live approval step is the
   wrong shape for a compliance-sensitive decision.
2. A recruiter scanning a ranked shortlist + rationale can catch a systematically unfair pattern (e.g.,
   penalizing employment gaps) before it affects real candidates — an agent that silently rejects removes
   that check entirely.

The final hire/reject decision, and the record of who made it, belongs to the human recruiter reviewing the
queue, not the agent.

## 6. Deployment

Single-node self-host per doc 00 §6: one container, `/data` volume for `koboi_memory.db` (+ WAL files) and
`keys.json`. Trigger pattern is push-based (ATS webhook → submitter script → `POST /v1/jobs`) or a cron
sweep:

```bash
# nightly cron: sweep ATS/S3 for resumes without a screening job yet,
# submit one POST /v1/jobs per resume (see SS1 for why one-per-resume)
0 2 * * * /opt/hr-screening/submit_new_resumes.sh
```

```bash
docker compose run --rm koboi koboi keys create --label hr-screening-prod
python -m hr_ext.entrypoint   # NOT bare `koboi serve` -- see below
```

`koboi serve` (the stock CLI) has no flag to preload a custom module, and hook registration (§4c) must run
before `KoboiAgent.from_config()` builds the agent. So this project's Dockerfile `CMD` runs
`python -m hr_ext.entrypoint` — which imports `hr_ext.hooks` then calls `koboi.server.app.serve_app(...)`
directly — instead of the bare `koboi serve` command.

## 7. What this demonstrates

This sector showcases koboi's **autonomous job mode** as the right fit for a batch, no-human-present workload
— jobs unconditionally reject `yolo` and always run inside `sandbox.backend: restricted`, regardless of
server config. It also showcases the **custom hook** extension point as a compliance control plane: since job
mode has no live approval step, the hook system is where the audit trail gets built, and the tool design
(`score_candidate` writes an advisory recommendation, never a rejection) keeps a human recruiter as the actual
decision-maker via a review queue rather than a live approval prompt.

## 8. Open questions

- **Per-requisition JD/rubric scale**: at what number of concurrent open reqs does hardcoding the JD/rubric
  into `agent.system_prompt` stop working, such that a RAG retriever (doc 00 §5) keyed by `req_id` is worth
  the complexity? Needs a volume estimate from the TA team.
- **Audit store target**: doc 00 doesn't cover durable storage beyond the per-session sandbox workdir (§7,
  "no artifact-retrieval endpoint"). Where does `ScoringAuditHook`'s log actually live — a WORM bucket, a
  compliance vendor's API, a warehouse table? Needed before `_append_only_write` is real.
- **ATS write-back contract**: does the target ATS expose a "review queue"/custom field recruiters actually
  look at, or does `score_candidate` need to land results elsewhere for recruiters to see them?
- **Per-tenant job isolation**: doc 00 §7 flags multi-tenant isolation as "interface-ready but not
  runtime-enforced in v1." If multiple hiring teams share one instance (multiple API keys), is that
  acceptable, or does each team need its own instance?
- **Retry/failure UX**: on `failed`/`timed_out` (e.g., unparsable resume format), who gets notified — does the
  submitter retry automatically, or does a failed job sit for a human to notice via `GET /v1/jobs`? No
  webhook delivery exists (doc 00 §7), so this is pull-only by design.
