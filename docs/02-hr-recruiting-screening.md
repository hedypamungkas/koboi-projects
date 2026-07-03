# HR & Recruiting — Screening Resumes at Scale

> Read [`docs/00-consuming-koboi-server.md`](00-consuming-koboi-server.md) first. This doc only covers what's
> different for resume screening.

Every night, turn the day's new resumes into a ranked shortlist per job, each score with a plain-English
reason attached, for recruiters to review in the morning.

## The scenario

Northstar Talent is a 200-person tech company hiring for 25 open roles at once, with a talent acquisition
team of three people. Resumes arrive faster than anyone can read them, and a rushed skim isn't consistent
from one candidate to the next. Northstar wants every resume compared against the same job requirements the
same way, with a written reason for each score — and nobody needs to watch it happen live. Resumes come in
during the day, get screened overnight, and land in a dashboard the recruiters check each morning.

## What you get for free

This is a batch job, not a conversation — koboi's **job mode** (`POST /v1/jobs`, doc 00 §2) is built for
exactly this: submit one resume, get a `job_id`, poll or stream for the result, no one has to be watching.
Session memory, retries, and concurrency limits are already part of the server, so submit one job per resume
(a bad PDF then only fails that one candidate) and let koboi's job runner handle the rest. The batch pipeline
itself needs almost no custom infrastructure — you're mostly writing two tools that talk to your ATS, and a
small hook that keeps a record of every decision for later review.

## What you build

Two tools and one hook — everything else is koboi's job runner.

**`fetch_resume`** — read-only, so it's `SAFE`:

```python
from koboi.tools.registry import tool
from koboi.types import RiskLevel

@tool(
    name="fetch_resume",
    description="Fetch a candidate's resume text and metadata by resume_id.",
    parameters={
        "type": "object",
        "properties": {"resume_id": {"type": "string"}},
        "required": ["resume_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def fetch_resume(resume_id: str) -> str:
    text, metadata = await ats_client.fetch(resume_id)
    return f"{metadata}\n---\n{text}"
```

**`score_candidate`** — writes a recommendation, never a decision, so it's `MODERATE` not `DESTRUCTIVE`. The
agent recommends, a recruiter decides — jobs run unattended with no approval prompt (doc 00 §2), so this
tool writes to a review-queue field, never a "rejected" status:

```python
@tool(
    name="score_candidate",
    description="Record a fit score + rationale for a candidate. Advisory only -- never rejects or advances.",
    parameters={
        "type": "object",
        "properties": {
            "resume_id": {"type": "string"},
            "score": {"type": "number", "description": "0-100 fit score"},
            "rationale": {"type": "string", "description": "why this score, citing job criteria"},
            "recommendation": {"type": "string", "enum": ["strong_match", "possible_match", "weak_match"]},
        },
        "required": ["resume_id", "score", "rationale", "recommendation"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def score_candidate(resume_id: str, score: float, rationale: str, recommendation: str) -> str:
    await ats_client.write_review_queue(resume_id, score, rationale, recommendation)
    return f"Recorded score={score} for {resume_id}"
```

**`ScoringAuditHook`** — the safety net for a job that has no live human approval: every score gets logged
before anything downstream can touch it, so a bias/compliance review always has the full rationale to check:

```python
from koboi.hooks.chain import Hook, HookContext, HookEvent
from koboi.hooks.registry import HookEntry, register_hook

class ScoringAuditHook(Hook):
    def handles(self) -> list[HookEvent]:
        return [HookEvent.POST_TOOL_USE]

    async def execute(self, ctx: HookContext) -> HookContext:
        if ctx.tool_name == "score_candidate":
            append_only_log.write({
                "resume_id": ctx.tool_arguments["resume_id"],
                "rationale": ctx.tool_arguments["rationale"],
                "result": ctx.tool_result,
            })
        return ctx

register_hook(HookEntry(
    name="ScoringAuditHook",
    should_add=lambda config, **kw: True,
    factory=lambda config, **kw: ScoringAuditHook(),
))
```

Hooks aren't wired through YAML (doc 00 §5) — `register_hook()` must run once before the server builds the
agent, so the entrypoint imports the hooks module and then starts the server, instead of the bare `koboi serve`.

## Architecture

```
ATS webhook / nightly cron        koboi server (Docker)             Recruiter dashboard
        │                                 │
        ▼                                 ▼
  POST /v1/jobs               fetch_resume → ATS API
  (one job per resume)        score via LLM call
        │                     score_candidate → ATS review queue
        │                     ScoringAuditHook → audit log
        │                                 │
        └── GET /v1/jobs?status=completed (poll) ──────────────▶ ranked shortlist + reasons
```

## The frontend

This is a dashboard, not a chat window — recruiters don't type messages, they review a list. One table per
open role: candidate name, score, the agent's rationale, and two buttons, "approve for interview" and
"pass". No streaming needed; the page polls for finished jobs instead of following a live conversation.

```js
// poll for newly completed screening jobs, per doc 00 §2
async function pollCompletedJobs(onBatch) {
  const res = await fetch("/v1/jobs?status=completed", {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const { jobs } = await res.json();
  onBatch(jobs); // each job's result holds resume_id, score, rationale, recommendation
}
setInterval(() => pollCompletedJobs(renderShortlist), 60_000);
```

## Docker

```yaml
services:
  koboi:
    build: ./backend        # koboi-agent[api] + hr_ext, pip install -e .
    ports: ["8000:8000"]
    volumes: ["koboi-data:/data"]
    env_file: .env
    command: python -m hr_ext.entrypoint   # imports hooks, then starts the server
  dashboard:
    build: ./frontend       # static build, served by nginx
    ports: ["3000:80"]
    depends_on: [koboi]
volumes:
  koboi-data:
```

## config/agent.yaml

```yaml
agent:
  mode: act              # jobs reject yolo unconditionally either way (doc 00 SS2)
  system_prompt: |
    Score the candidate against the job description and rubric below.
    Call score_candidate exactly once with a numeric score, a rationale
    citing specific criteria, and a recommendation. You do not reject
    or advance candidates -- a human recruiter makes that call.

tools:
  custom:
    - module: hr_ext.tools

jobs:
  enabled: true
  max_concurrent: 10     # bounds a burst of resumes on this one instance
  timeout_seconds: 300
```

## Why it matters

The screening pipeline itself is mostly configuration: koboi already knows how to run a job, retry it, and
report its result. What Northstar actually had to build was two small tools that talk to their own ATS and
one hook that keeps a record — a day or two of work, not a new platform. That's the same story every use case
in this repo tells: start with what's built in, add the specific business logic your company needs on top,
and never touch koboi's own code to do it.

## Open questions

- **Where does the audit log live?** Doc 00 doesn't define durable storage beyond a per-session workdir —
  a real deployment needs a WORM bucket, compliance vendor, or warehouse table behind `ScoringAuditHook`.
- **Does the target ATS have a review-queue field recruiters actually see?** If not, `score_candidate` needs
  a different write target for the dashboard to read from.
- **At what number of open roles does hardcoding each job's requirements into the system prompt stop
  working?** Past some point a retriever keyed by requisition ID (doc 00 §5) is probably worth it.
