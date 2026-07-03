# Kessler & Vance -- Contract Review Assistant

A runnable demo of `koboi-agent` consumed as an installed package: a first-pass contract-clause
reviewer backed by a koboi server, extended with two small draft-only tools and a clause playbook
that's pure Markdown (koboi Skills). See
[`docs/05-legal-contract-review.md`](../docs/05-legal-contract-review.md) for the design doc this
app implements, and [`docs/00-consuming-koboi-server.md`](../docs/00-consuming-koboi-server.md)
for the shared API contract (auth, streaming, jobs vs. chat).

## What's here

```
legal-contract-review/
  pyproject.toml            # legal_ext installable package
  config/agent.yaml         # koboi config: skills, tools, server
  src/legal_ext/
    tools.py                # propose_redline, flag_novel_clause
  playbook_skills/           # the clause playbook -- Markdown, no retriever code
    indemnification/SKILL.md
    limitation_of_liability/SKILL.md
    termination/SKILL.md
  backend/Dockerfile        # koboi-agent[api] + legal_ext, `koboi serve`
  frontend/                 # clause review workspace + follow-up chat (nginx, static)
  docker-compose.yml
```

## What's built in vs. what's custom

- **Built in, zero code**: koboi's Skills system surfaces the right clause-type playbook to the
  model based on what's being discussed (`skills.search_paths`) -- no retriever, no chunking, no
  embeddings, just Markdown files the firm edits directly. Chat memory and the human-approval
  pause come for free too -- see the note on `RiskLevel.MODERATE` below, since it turns out this
  app actually exercises the approval flow.
- **Custom** (`src/legal_ext/tools.py`): `propose_redline` drafts a suggested fix using the
  matching skill's fallback language; `flag_novel_clause` escalates anything with no playbook
  match. Both are draft/flag-only -- neither tool sends, files, or signs anything. `propose_redline`
  is `RiskLevel.MODERATE` and `flag_novel_clause` is `RiskLevel.SAFE`.

The playbook currently covers three clause types (`indemnification`, `limitation_of_liability`,
`termination`) as a runnable slice of doc 05's full five-category list (`ip_assignment` and
`confidentiality` are called out there but not built here) -- adding a fourth is a new
`playbook_skills/<name>/SKILL.md` file, not a deploy.

## Running it

```bash
cd legal-contract-review
docker compose build
docker compose up -d
curl -sf http://localhost:8005/healthz
curl -sf http://localhost:8005/readyz
```

Then open `http://localhost:3005` for the review workspace, or hit the API directly:

```bash
curl -s -N -X POST http://localhost:8005/v1/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "Review this clause: Vendor shall indemnify Client for any and all claims without limitation."}'
```

Expect the indemnification skill to activate (visible as an `[ACTIVATE_SKILL: indemnification-clauses]`
marker in an early `text_delta`, per `koboi/skills/registry.py`'s discovery-prompt convention),
followed by a `tool_call` for `propose_redline` and then a `pending_approval` event -- `propose_redline`
is `RiskLevel.MODERATE`, and koboi's server-side approval handler pauses for a human on MODERATE
*and* DESTRUCTIVE tools alike (only SAFE auto-approves; see "Deviations" below). Resolve it before
the stream continues:

```bash
# from the pending_approval event's "approval_id" and the response's X-Session-Id header:
curl -s -X POST http://localhost:8005/v1/sessions/<session_id>/approve \
  -H "Content-Type: application/json" \
  -d '{"approval_id": "<approval_id>", "decision": "approve"}'
```

The original stream then resumes and ends in `complete` with `"tools_used":["propose_redline"]`.
The frontend at `http://localhost:3005` handles this automatically via an approve/reject card (see
`frontend/app.js:renderApprovalCard`) -- only `curl`-only testing needs the manual step above.
A clause with no playbook match (e.g. "resolved via binding arbitration under the laws of the
Moon") calls `flag_novel_clause` instead, which is `RiskLevel.SAFE` and auto-approves -- no
`pending_approval` step for that path.

Bring it down with `docker compose down`.

### Where the OpenAI credentials come from

`docker-compose.yml`'s `koboi` service points `env_file` at the sibling `koboi-agent` repo's
`.env` (absolute path), which already has `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL`
populated for this workstation. If you're running this outside that environment, copy
`.env.example` to `.env` in this directory, fill it in, and change `env_file` in
`docker-compose.yml` to point at it instead.

## Deviations from the spec docs (and why)

- **`skills.search_paths` is absolute (`/app/playbook_skills`)**, matching where
  `backend/Dockerfile` `COPY`s the folder -- doc 05's inline example config uses a relative
  `./playbook_skills`, which only resolves correctly if the process's cwd matches; the absolute
  path is unambiguous inside the container.
- **`event.content` / `event.tool_name`, not `event.delta` / `event.name`**: doc 00 §3's and doc
  05's illustrative `streamChat` snippets read `event.delta` for text and `event.name` for the
  tool-call name. The real SSE payload (`koboi/events.py:event_to_dict`) uses `content` for
  `TextDeltaEvent` and `tool_name` for `ToolCallEvent` -- verified directly against source and
  used as-is in `app.js`, since the doc's field names don't exist on the wire. `app.js`'s
  `POST /v1/sessions/{id}/approve` call also uses the real `ApproveRequest` shape
  (`{"approval_id", "decision"}`, `koboi/server/schema.py`), not the `{"approved": true}` shape
  doc 00's illustrative snippet implies.
- **`propose_redline` (`RiskLevel.MODERATE`) does pause for human approval, contra doc 05's claim
  that "there's nothing to approve mid-run because nothing leaves the session."** Verified against
  `koboi/guardrails/approval.py:AsyncCallbackApprovalHandler.should_approve`: with
  `auto_approve_safe=True` (the server's default), only `RiskLevel.SAFE` tools auto-run; MODERATE
  and DESTRUCTIVE both prompt the handler, and the REST/SSE server always wires one. Confirmed
  live -- the first e2e run without approval-handling in the frontend just hung on a
  `pending_approval` event until the 120s timeout. Rather than treat this as a bug to route
  around, the frontend leans into it: an approve/reject card (`frontend/app.js:renderApprovalCard`,
  copied from the ecommerce-support build's pattern) gates the redline draft behind a human click,
  which is arguably a *better* fit for "a lawyer reviews and sends everything" than doc 05's
  original claim of no mid-run approval at all. `flag_novel_clause` stays `RiskLevel.SAFE` and
  auto-approves, since it's a pure escalation signal.
- **`agent.system_prompt` adds "call the tool, don't just write the redline yourself"** to the
  task's given wording. Without that line, `gpt-5.4-mini` sometimes answered by writing the
  fallback language directly into its text response (still correct per doc 05's guidance, and
  still passes the E2E recipe's own flexible bar of "either directly in the answer text, or via a
  `tool_call`") instead of invoking `propose_redline` -- the stronger wording makes the tool call
  (and therefore the approval gate above) fire reliably for the e2e demo.
- **`skill.description` includes multiple word forms** (e.g. "indemnification (indemnify,
  indemnifies)") rather than just the noun form from doc 05's worked example. koboi's skill
  router (`koboi/skills/registry.py:SkillRegistry.route`) does exact word-set matching with no
  stemming, so a clause phrased with "indemnify" wouldn't score against a description containing
  only "indemnification" -- verified locally with `SkillRegistry.route()` before relying on it
  for the e2e test.
- **`tools.builtin`** includes `memory_store`/`memory_recall` (not in the task's YAML skeleton) so
  chat memory is actually wired up turn to turn, matching every other use case in this repo.
  `jobs.enabled: true` is also set (the task's YAML skeleton omits a `jobs:` section) since doc
  05's architecture explicitly includes an overnight batch job over `/v1/jobs`, even though this
  build's e2e recipe only exercises the chat path.
- **`server.enabled` defaults to `False`** in the schema but `koboi serve` doesn't gate on it
  (verified in `koboi/cli.py:_run_serve` -- host/port come from CLI args, not this flag), so it's
  cosmetic either way; set `true` to match the other example configs in `koboi-agent/configs/`.
- **Frontend is one page with two panels** (clause review + follow-up chat) rather than doc 05's
  fuller side-by-side document viewer mockup, per this task's simpler file tree
  (`frontend/index.html` + `frontend/app.js`, no build step).
- **Cross-origin frontend**: the web (nginx, static-only) and koboi containers are on different
  ports (`3005` vs `8005`), so `app.js` calls `http://localhost:8005` directly and
  `config/agent.yaml` sets `server.cors.allow_origins: ["*"]`. It also sets
  `cors.expose_headers: ["X-Session-Id"]` -- without it, `CORSMiddleware` (see
  `koboi/server/app.py`) defaults to exposing no response headers cross-origin, so `app.js`'s
  `res.headers.get("X-Session-Id")` would always read `null` and the review panel and follow-up
  chat would silently never share a session. In production you'd put both behind one
  reverse-proxy host instead, which sidesteps this entirely.
- **`auth_required: false`**: set for this local smoke-test POC only, per the task spec. In
  production this must be `true`, with tokens minted via `koboi keys create` and sent as
  `Authorization: Bearer <token>` on every request (`docs/00` §4) -- `app.js` has the header
  plumbing in place behind an `AUTH_REQUIRED` flag, just toggled off here.
- **`agent.mode: act`, not `chat` -- fixed post-merge, was a real live bug.** The build originally
  shipped with `agent.mode: chat`. That looked fine in a quick e2e pass because koboi's tool
  pipeline resolves approval *before* the mode-block check (`koboi/loop_pipeline.py`): a
  `pending_approval` that times out unresolved denies the tool before the pipeline ever reaches
  `ModeHook`, so a superficial test (send a message, wait for `complete`) can look like it passed
  even though the tool never really ran. Confirmed with `flag_novel_clause` (`SAFE`, no approval
  pause) hitting `"Error: CHAT mode: tool 'flag_novel_clause' is not allowed"` immediately, and
  `propose_redline` (`MODERATE`) hitting the same block right after a human approval -- discarding
  the approval. Fixed by setting `agent.mode: act`; re-verified both tools end to end, including
  actually resolving the approval and checking the real `tool_result` content, not just that a
  `complete` event eventually arrived.

## Open questions carried over from doc 05

- Where do `flag_novel_clause` outputs land for an unattended overnight job, given koboi has no
  webhook/notification mechanism (doc 05, doc 00 §9)? This demo only surfaces flags inline in the
  current chat turn or job output.
- How long should contract text sit in koboi's session memory (`/data/koboi_memory.db`)? No
  shorter retention window or field-level encryption is configured beyond the volume itself.
- `allowed-tools`/`disallowed-tools` in `SKILL.md` frontmatter aren't enforced by koboi today --
  they document intent to the model only. `propose_redline` stays at `RiskLevel.MODERATE` (not a
  looser risk level) as the actual control.

## Production notes

- Flip `server.auth_required: true` and mint keys with
  `docker compose run --rm koboi koboi keys create --label prod`.
- Swap `sandbox.backend: passthrough` (implicit default) for `restricted`, per
  `configs/server_deploy.yaml` in the koboi-agent repo.
- Add the two remaining playbook categories from doc 05 (`ip_assignment`, `confidentiality`) as
  more `playbook_skills/<name>/SKILL.md` folders -- no code change, no deploy.
- Wire an overnight `/v1/jobs` submission per incoming contract once the firm's CLM/DMS can push
  or poll for it (`jobs.enabled: true` is already set in `config/agent.yaml`). Unlike chat,
  `/v1/jobs` runs under `koboi/guardrails/approval.py:AutonomousApprovalHandler`, which
  auto-approves SAFE *and* MODERATE tools (only DESTRUCTIVE needs a Trust DB rule) -- so
  `propose_redline` won't hang a job waiting on a human the way it does in chat. That's the
  built-in version of doc 05's "jobs can't pause for a human" principle, not something this app
  had to design in.
