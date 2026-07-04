# hr-screening -- Northstar Talent resume screening

Full-stack demo for [`docs/02-hr-recruiting-screening.md`](../docs/02-hr-recruiting-screening.md): a nightly
batch that scores resumes against a job requisition using koboi-agent's **job mode**
(`POST /v1/jobs`), no live human in the loop, plus a recruiter dashboard that polls for
finished jobs.

koboi core is never modified -- everything here is a small installable Python package
(`hr_ext`) plus one YAML config, consumed exactly the way `docs/00-consuming-koboi-server.md`
describes.

## What's in here

| Path | What |
|---|---|
| `src/hr_ext/tools.py` | `fetch_resume` (SAFE), `score_candidate` (MODERATE, advisory-only) |
| `src/hr_ext/hooks.py` | `ScoringAuditHook` -- appends every score to `/data/audit/scoring_audit.jsonl` |
| `src/hr_ext/entrypoint.py` | Own process entrypoint (see "Why not `koboi serve`" below) |
| `config/agent.yaml` | Agent config: `act` mode, jobs enabled, no auth (local POC) |
| `backend/Dockerfile`, `frontend/` | Docker images; `docker-compose.yml` wires them together |

## Why not the bare `koboi serve` CLI

`koboi serve <config>` has no YAML key or entry-point group for custom **hooks** --
`tools.custom` and `rag.custom_modules` / `context.custom_modules` exist, but hooks don't. The
real way in, verified against the real PyPI `koboi-agent==0.4.0` package
(`koboi/server/app.py::create_app`), is:

```python
create_app(config: Config, *, extra_tools=(), extra_hooks=(), approval_handler=None,
           extra_middleware=(), extra_routes=(), workspace_root="./workspace",
           cap=100, enable_cors=True, api_keys=None) -> FastAPI
```

So `hr_ext/entrypoint.py` builds the `Config`, calls
`create_app(cfg, extra_hooks=[_as_extra_hook(ScoringAuditHook())])` itself, and runs `uvicorn.run(app, ...)`
-- `tools.custom: [{module: hr_ext.tools}]` in the YAML is enough for the tools (that path is handled by
koboi's own facade regardless of how the process starts); `extra_hooks` is the one piece that has to be
wired by hand.

**`_as_extra_hook` adapter, found only by actually running this against the wheel:** passing a bare `Hook`
instance (`extra_hooks=[ScoringAuditHook()]`) crashes on the first request with
`TypeError: 'ScoringAuditHook' object is not subscriptable`. Verified against the installed
`koboi.server.pool.AgentPool._build_agent` -- it only accepts a bare callable (defaults to running on
*every* `HookEvent`, see `CallbackHook.__init__`) or a `(callback, events)` tuple per `extra_hooks` entry,
not a `Hook` ABC subclass instance. `entrypoint.py`'s `_as_extra_hook(hook)` returns
`(hook.execute, hook.handles())` so `ScoringAuditHook` keeps firing only on `POST_TOOL_USE` as declared.

## Deviations from the spec doc worth flagging

1. **`ctx.tool_arguments` is a JSON string, not a dict.** `docs/02`'s sample hook does
   `ctx.tool_arguments["resume_id"]` directly. Verified against the installed
   `koboi.hooks.chain.HookContext` (`tool_arguments: str | None`) and `koboi.types.ToolCall.arguments: str`
   -- it's the raw JSON string the LLM produced for the call. `ScoringAuditHook.execute` does
   `json.loads(ctx.tool_arguments)` before reading fields.
2. **`GET /v1/jobs?status=completed` doesn't inline the result.** Verified against the installed
   `koboi/server/app.py::list_jobs` route -- it returns only `{job_id, status, session_id}`, not the
   `result` payload doc 02's pseudo-code implies. `app.js` does a second `GET /v1/jobs/{job_id}` per
   completed job to pull `result.content` (the agent's final message text). To make that machine-parsable,
   the system prompt in `config/agent.yaml` asks the model to end its turn with a bare JSON object
   (`{resume_id, score, rationale, recommendation}`); `app.js` parses it with a raw-text fallback if the
   model doesn't comply.
3. **"Approve for interview" / "Pass" buttons are local-only.** There's no ATS write-back target in this
   demo (`score_candidate` writes to `/data/review_queue.json`, not a real ATS), so those buttons just mark
   a row's decision in the browser tab; nothing is persisted server-side. A real deployment would POST the
   decision back to the ATS.
4. **`server.auth_required: false`** is a local smoke-test simplification. In production this would be
   `true`, with real API keys minted via `koboi keys create` (doc 00 SS4) and sent as
   `Authorization: Bearer <token>` from the dashboard.
5. **`memory.db_path: /data/koboi_memory.db`** was added (not in doc 02's snippet) so the jobs/ownership
   sidecar DB persists in the mounted volume instead of resetting on restart -- without it, koboi's own
   `_sidecar_db_path` falls back to the bare-filename default inside the container's ephemeral filesystem.

## Run it

```bash
cd hr-screening
docker compose build
docker compose up -d
sleep 3
curl -sf http://localhost:8002/healthz
curl -sf http://localhost:8002/readyz

JOB=$(curl -s -X POST http://localhost:8002/v1/jobs -H "Content-Type: application/json" \
  -d '{"message": "Score resume R-001 against the Senior Backend Engineer requisition"}')
echo "$JOB"
JOB_ID=$(echo "$JOB" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")

for i in $(seq 1 20); do
  STATUS=$(curl -s http://localhost:8002/v1/jobs/$JOB_ID)
  echo "$STATUS"
  echo "$STATUS" | grep -q '"status":"completed"' && break
  sleep 2
done

docker compose run --rm koboi cat /data/audit/scoring_audit.jsonl
```

Then open http://localhost:3002 for the dashboard -- submit a `resume_id` (`R-001`..`R-004` are the
sample resumes hardcoded in `tools.py`) and watch it show up once koboi finishes scoring it.

## Sample resumes

`fetch_resume` has four hardcoded candidates standing in for a real ATS: `R-001` (strong backend fit),
`R-002` (frontend, weak fit), `R-003` (adjacent backend languages, partial fit), `R-004` (senior but
non-hands-on, mixed fit) -- enough to see the score/rationale/recommendation spread across the shortlist.
