# Harbor Realty Group -- Buyer Chat + Nightly Listing Automation

A runnable demo of [`docs/06-real-estate-property-management.md`](../docs/06-real-estate-property-management.md):
one koboi-agent deployment that answers buyer questions on the listings site all day (chat mode) and drafts
listing descriptions + lead follow-up emails every night (job mode), fanning the nightly batch out in
parallel with the built-in `delegate_tasks` tool.

Read [`docs/00-consuming-koboi-server.md`](../docs/00-consuming-koboi-server.md) first if you haven't --
this app follows that contract exactly (one config, one container, custom tools via `tools.custom`).

## What's here

```
real-estate/
  pyproject.toml               installable "realestate_ext" package
  config/agent.yaml            the one koboi config -- drives both chat and jobs
  src/realestate_ext/tools.py  lookup_property, draft_listing_description, draft_followup_email
  backend/Dockerfile           koboi-agent[api] + realestate_ext
  frontend/                    buyer chat widget + agent dashboard (static, no build step)
  docker-compose.yml           wires both up
```

## Custom tools vs. built-in fan-out

Only `lookup_property` (SAFE), `draft_listing_description` (MODERATE), and `draft_followup_email`
(MODERATE) are custom code -- see `src/realestate_ext/tools.py`. There's no real CRM behind them; each
looks up / writes into a small in-memory dict standing in for Harbor's Yardi/AppFolio-style system. The two
draft tools only ever write a draft -- nothing is published or sent, which is why they stay `MODERATE`
instead of `DESTRUCTIVE` (jobs run unattended with no approval step, so nothing a job does can require one).

The nightly batch's parallel fan-out is **not custom code** -- it's koboi's built-in `delegate_tasks` tool
(`koboi/tools/builtin/subagent.py`). It takes `{"tasks": [{"task": "...", "label": "..."}]}`, max 10 items
per call, and runs each as an independent sub-agent in parallel, returning every result in one tool result.
The system prompt in `config/agent.yaml` tells the agent to call `delegate_tasks` with one sub-task per
property/lead, each sub-task naming the exact tool + ID to call (e.g. "Call draft_listing_description with
property_id=P-101").

**Important config detail, verified against `koboi/facade.py` (`_build_tools`) and
`koboi/config_models.py` (`ToolsConfig`):** `tools.builtin` is not a pure allowlist layered on top of an
always-registered builtin set -- it's a gate. If `tools.builtin` is empty or absent, **no** builtin tools
are registered at all, `delegate_tasks` included. Only when the list is non-empty does koboi register every
builtin tool and then filter down to that list. So `config/agent.yaml` sets:

```yaml
tools:
  builtin: [delegate_tasks]
  custom:
    - module: realestate_ext.tools
```

`[delegate_tasks]` both turns the tool on and keeps out builtins we don't want here (`run_shell`,
`filesystem`, etc.) -- this deviates from the task's starter YAML, which left the builtin allowlist commented
out pending verification; verification showed it's required.

## Sample data

`src/realestate_ext/tools.py` hardcodes:
- 4 properties (`P-101`..`P-104`) -- 2 for-sale condos/houses, 1 rental apartment, 1 townhouse -- each with
  address, beds/baths, sqft, price, and a list of raw features the drafting tool turns into marketing copy.
- 3 leads (`L-001`..`L-003`) -- name, property of interest, last contact date, and notes. `L-002` (Marcus
  Webb) is deliberately stale (last contacted 2026-06-20) to exercise the follow-up path.

## Running it

```bash
cd real-estate
docker compose build
docker compose up -d
sleep 3
curl -sf http://localhost:8006/healthz
curl -sf http://localhost:8006/readyz
```

Then open http://localhost:3006 for the buyer chat widget + agent dashboard, or drive a nightly batch
directly:

```bash
JOB=$(curl -s -X POST http://localhost:8006/v1/jobs -H "Content-Type: application/json" \
  -d '{"message": "Draft listing descriptions for the 3 new properties and a follow-up email for stale lead L-002"}')
echo "$JOB"
JOB_ID=$(echo "$JOB" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
for i in $(seq 1 20); do
  STATUS=$(curl -s http://localhost:8006/v1/jobs/$JOB_ID)
  echo "$STATUS"
  echo "$STATUS" | grep -q '"status":"completed"' && break
  sleep 2
done
docker compose down
```

`docker-compose.yml` points `env_file` at an **absolute path outside this repo**
(`/Users/mekari/Documents/Research-POC/ai-agent-sample/koboi-agent/.env`) for `OPENAI_API_KEY` /
`OPENAI_MODEL` / `OPENAI_BASE_URL` -- see `.env.example` for the variable names only; the real key is never
committed here.

## Deviations from the task's starter `config/agent.yaml`

All three found by actually running the e2e recipe below against a real server, not by inspection alone:

1. **`tools.builtin: [delegate_tasks]` is required, not optional.** Covered above -- `koboi/facade.py`'s
   `_build_tools` only calls `register_all()` (which registers `delegate_tasks` along with every other
   builtin) when `tools.builtin` is non-empty. Leaving it empty, as the starter YAML did, means
   `delegate_tasks` doesn't exist at all.
2. **`sandbox.backend: restricted` is required for jobs to run at all**, independent of whether a tool needs
   subprocess/filesystem isolation. `koboi/server/jobs.py`'s `_execute_job` hard-refuses with
   `PermissionError: Autonomous jobs require sandbox.backend='restricted'; 'passthrough' is refused` before
   running anything -- confirmed by hitting `POST /v1/jobs` against the starter config's implicit
   `sandbox.backend: passthrough` default and getting `status: failed` with exactly that error. None of our
   three tools touch the filesystem or shell out, but the check isn't tool-aware; it's a blanket job-mode
   gate. Added a `sandbox:` block (`backend: restricted`, `workdir: /data/workspace`,
   `workdir_strategy: per_session`, `network: deny`) modeled on `koboi-agent/configs/server_deploy.yaml`.
3. **`agent.mode: act` is required as the config default**, not `chat` (the pydantic default, and what the
   starter YAML implicitly left in place). `koboi/hooks/mode_hook.py`'s `ModeHook` hard-blocks (denies the
   tool call outright, not just discourages it) any tool whose name isn't in a small hardcoded read-only
   allowlist (`read`, `search`, `web_search`, ... plus `delegate_tasks`) whenever the *runtime* mode is CHAT
   or PLAN. That allowlist has no way to know about custom tools, so at `mode: chat` even `lookup_property`
   (SAFE) gets denied with `"CHAT mode: tool 'lookup_property' is not allowed"` -- confirmed the same way,
   by asking a property question and getting that error back instead of an answer. Neither the job payload
   nor this repo's `streamChat` call sends a per-request `mode`, so the config default is what actually runs
   both paths; `mode: act` lifts the block for every tool while the safety story doc06 cares about is
   unaffected either way, because it comes from risk level, not mode: DESTRUCTIVE tools would still pause
   for approval (docs/00 §5) -- moot here, we have none -- and MODERATE tools never publish/send regardless
   of which mode reached them (by construction in `src/realestate_ext/tools.py`). `server.allowed_modes`
   still exists for a caller that wants to pass an explicit per-request `mode`.

One more prompt-level adjustment, not a config bug but worth flagging: the e2e test message ("draft
descriptions for the 3 new properties... stale lead L-002") never states which IDs are "new" -- there's no
"list new properties" tool in scope for this task, only ID-keyed lookups. Without a hint, the model guessed
plausible-looking IDs (`P-001`/`P-002`/`P-003`) that don't exist in the sample data and the batch partially
failed. `config/agent.yaml`'s system prompt now tells the agent which sample IDs are "tonight's batch" as a
fallback when a caller doesn't name them explicitly, and notes that a real cron-triggered job would just
name the exact IDs itself (it already queried the CRM for them to build the job message in the first place).

## Production notes (deliberately simplified for this local POC)

- `server.auth_required: false` in `config/agent.yaml` -- production would set this `true` and issue tokens
  via `koboi keys create` (docs/00 §4), then have the frontend send `Authorization: Bearer <token>`.
- `server.cors.allow_origins: ["*"]` -- production would lock this to the listings site's real origin.
- The "agent dashboard" tab lists job runs via `GET /v1/jobs` / `GET /v1/jobs/{id}` and shows each job's
  final message as the record of what was drafted. koboi has no "list drafts" endpoint of its own -- in a
  real deployment, humans would review drafts inside the CRM's own draft view (or a dashboard reading
  straight from the CRM), not from koboi's job history. The "Run nightly batch now" button is a demo
  convenience; production triggers the same `POST /v1/jobs` from an external cron, not a browser button.
- The nightly cron itself lives outside this repo (any scheduler Harbor already runs) -- it just calls
  `POST /v1/jobs` once per batch.
