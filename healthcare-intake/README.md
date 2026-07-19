# Riverside Family Clinic: Pre-Visit Patient Intake

A demo full-stack app showing koboi-agent consumed as an installed package: a patient-facing intake
chat, grounded in the clinic's own (fake, illustrative) triage protocol via koboi's built-in RAG, with
one narrowly-scoped tool and a custom PHI-redaction guardrail layered on top. See
[`docs/04-healthcare-patient-intake.md`](../docs/04-healthcare-patient-intake.md) in the repo root for
the full scenario writeup, and [`docs/00-consuming-koboi-server.md`](../docs/00-consuming-koboi-server.md)
for the pattern shared by every use case in this repo.

**Not a real clinic. Not medical advice.** The seed documents under `data/seed/` are fictional,
illustrative content written for this demo.

## Run it

```bash
cd healthcare-intake
docker compose build
docker compose up -d
sleep 3
curl -sf http://localhost:8004/healthz
curl -sf http://localhost:8004/readyz
curl -s -N -X POST http://localhost:8004/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message": "I have had a fever and cough for 3 days"}'
docker compose exec koboi cat /data/escalations.log   # expect: file empty or missing (routine symptom)
docker compose down
```

Then open http://localhost:3004 for the patient chat.

Copy `.env.example` to `.env` in this directory and fill in your own `OPENAI_API_KEY` (and
`OPENAI_MODEL`/`OPENAI_BASE_URL`/`EMBEDDING_*` if needed). `docker-compose.yml` reads it via
`env_file: [.env]`. `.env` is gitignored -- never commit real credentials.

## What's built

| Piece | Purpose |
|---|---|
| `src/healthcare_ext/tools.py` | `flag_urgent_escalation` -- the only tool. `SAFE` risk level, appends one line to `/data/escalations.log`. No EHR write, no filesystem/shell access, nothing else. |
| `src/healthcare_ext/guardrails.py` | `PHIRedactionGuardrail` -- flags phone numbers, dates of birth, and insurance-ID-looking strings that koboi's built-in `detect_sensitive` filter doesn't catch. |
| `data/seed/*.md` | Fake clinical protocol (red-flag symptom combinations) + intake question list, loaded into RAG. |
| `config/agent.yaml` | Wires it all together: RAG over the seed docs, `smart_truncation` context, the custom tool and guardrail, CORS, no-auth for local use. |
| `frontend/` | Plain HTML/JS patient chat, no build step, talking to `/v1/chat/stream` over SSE. |

## Deviations from the spec docs (and why)

- **Newly adopted (0.18 feature pass): `rag.rerank: true` + `query_rewrite: true` + `hyde: true`.** The
  hybrid retriever now heuristic-reranks and LLM-rewrites the patient query (incl. HyDE); all reuse the
  chat client (`koboi/rag/registry.py:486-489`), so no new key. Verified: a non-literal "sharp chest pain
  when I breathe" lifts the red-flag protocol and trips `flag_urgent_escalation` (`/data/escalations.log`).

Both `docs/04` and the original task brief describe an idealized config; a few of those specifics don't
match what `koboi/config_models.py` actually validates, or what the running server actually does. Each
was checked against the source before writing `config/agent.yaml` / `frontend/app.js`:

0. **`agent.mode: chat` + `mode.read_only_tools` (resolved in koboi 0.18+).**
   Both `docs/04` and the task brief specify `mode: chat` ("never act or yolo -- this is a live
   conversation with a patient"). Originally built against koboi 0.4.0, chat mode could not run
   `flag_urgent_escalation` at all: live-tested, a clear red-flag message (chest pain + shortness of
   breath) in `chat` mode produced a `tool_result: "Error: CHAT mode: tool 'flag_urgent_escalation' is
   not allowed..."` -- the escalation silently never happened and `/data/escalations.log` stayed empty
   even for a textbook emergency. Root cause: `koboi/hooks/mode_hook.py`'s `ModeHook` blocks every tool
   not on a hardcoded `_READ_ONLY_TOOLS` allowlist (`read`, `search`, `grep`, `find`, `list`, `glob`,
   `web_search`, `web_fetch`, `calculator`, `delegate_tasks`) in CHAT/PLAN, **regardless of its
   `RiskLevel`**. At 0.4.0 there was no extension point for that allowlist, so the workaround was
   `agent.mode: act` + `server.allowed_modes: [act]` (SAFE risk + `auto_approve_safe=True` meant no
   human-in-the-loop pause, so patient-facing behavior matched what "chat" was meant to convey).
   **koboi 0.18+ resolved this:** the top-level `mode.read_only_tools` list extends ModeHook's read-only
   set (wired in `hooks/registry.py` -> `ModeHook(extra_read_only=...)`). We now run the originally-
   intended `agent.mode: chat` with `mode.read_only_tools: [flag_urgent_escalation]` and
   `server.allowed_modes: [chat, act]`. Behavior is identical to the old act workaround at the tool level
   (SAFE tool, auto-approved, no `pending_approval`), but the mode now correctly reflects a live, read-only
   intake conversation -- and it drops the cosmetic ACT-mode system-prompt suffix ("you may modify files
   and run shell commands") that was untrue for this app.

1. **`rag.corpus_path` doesn't exist.** `docs/04`'s sample config uses `rag.corpus_path: ./data/seed`,
   but `RagConfig` (config_models.py) has no such field -- it has `documents: list[str | dict]`, each a
   `{path: ...}` dict, loaded individually in `koboi/rag/registry.py::_load_documents`. Using
   `corpus_path` would silently load zero documents (extra keys are ignored, not errored). Fixed to
   list both seed files explicitly under `rag.documents`, matching what the original task brief's own
   config skeleton already had right.

1b. **`rag.retriever: hybrid` + a dedicated `embedding:` block.** The chat `llm:` gateway doesn't serve
   embedding models, so hybrid retrieval needs its own embedding provider -- koboi-agent's
   `EmbeddingConfig` (`embedding:` top-level key) covers exactly this, decoupled from the chat client.
   Pointed it at `EMBEDDING_API_KEY`/`EMBEDDING_BASE_URL` (see `.env.example`); verified no embedding
   errors in the logs and retrieval still correctly grounds answers in the seed protocol docs.

2. **`guardrails.output` cannot be a list.** `docs/04` shows `guardrails.output: [phi_redaction]`, but
   `GuardrailsConfig.output` is typed as a single `OutputGuardrailConfig` object. Verified empirically:
   passing a list there raises `pydantic.ValidationError` (`Input should be a valid dictionary or
   instance of OutputGuardrailConfig`) and `Config.from_yaml()` re-raises it as `ValueError` --
   the server would fail to start. Only one dict-shaped guardrail can occupy the `output` slot.
   **Fix:** `guardrails.output: {name: phi_redaction, detect_sensitive: true}`. `_normalize_guardrail_config`
   (facade.py) treats a dict with a `name` key as a single custom-guardrail selection, so this builds
   *only* `PHIRedactionGuardrail` -- not koboi's built-in `content_filter` guardrail. To avoid losing
   secret-leak detection, `PHIRedactionGuardrail.__init__` reads the `detect_sensitive` kwarg and folds
   in `OutputGuardrail.PATTERNS` (the same patterns the built-in filter uses) when true. One guardrail
   instance, both responsibilities. This is a real behavior change from the literal task brief's YAML
   (`guardrails.output: {detect_sensitive: true}` with no `name` at all, which never wires the custom
   guardrail in at all) -- worth flagging since it would have silently defeated the whole point of
   writing `PHIRedactionGuardrail`.

2b. **`PHIRedactionGuardrail.check()` must accept a `context` kwarg (koboi 0.18+).** Surfaced by a real
   end-to-end test after the 0.18.2 bump: `BaseGuardrail.check(self, content, context: list[str] | None)`
   gained a `context` parameter (the retrieved RAG chunk strings, output path only), and the output
   pipeline now passes it as a keyword arg. Our override was `async def check(self, content)` -- so every
   reply ended the SSE stream with `{"type":"error","error":"PHIRedactionGuardrail.check() got an
   unexpected keyword argument 'context'"}` instead of completing. Fixed by widening the signature to
   `check(self, content, context=None)` (the guardrail redacts the model's *output*, so `context` is
   accepted but unused). Any custom `PatternGuardrail`/`BaseGuardrail` subclass overriding `check()` needs
   the same fix on 0.18+.

3. **`server.cors` is required, not optional, for the browser frontend to work.** Neither doc's config
   sketch includes a `cors:` block. `koboi/server/app.py` only adds `CORSMiddleware` when `server.cors`
   is explicitly present (a deliberate "no wildcard default" design) -- without it, the frontend
   (port 3004) calling the API (port 8004) cross-origin would fail with a CORS error in the browser.
   Added `server.cors.allow_origins: ["http://localhost:3004"]`.

4. **`docs/00`'s `streamChat` snippet has the wrong event field name.** It reads `event.text` for
   `text_delta` events. The actual `TextDeltaEvent` dataclass (`koboi/events.py`) has a `content` field,
   and `event_to_dict()` serializes it as-is -- the wire field is `content`, not `text`. `frontend/app.js`
   uses `event.content`.

5. **Multi-turn sessions need `X-Session-Id` echoed back.** `docs/00`'s snippet doesn't show this, but
   `/v1/chat/stream` (`koboi/server/app.py`) mints a new session per call unless the client echoes the
   `X-Session-Id` response header back as a request header. Without it, every patient message would
   start a fresh, context-free session -- exactly the "don't lose the first message" problem `docs/04`
   warns about, just worse. `frontend/app.js` captures and replays this header.

## Guardrail registration: entry point, with a same-package fallback

The task asked for `PHIRedactionGuardrail` to be registered via a `koboi.guardrails` Python entry point,
with an documented fallback allowed if that proved unreliable in practice. We use the entry point as the
primary path -- `pyproject.toml` declares it, and `koboi.plugins.discover_plugins()` runs automatically
at `import koboi` time and loads it once this package is `pip install`-ed (which the Dockerfile does via
`pip install -e .`). This worked reliably in testing; no fallback was needed to make it functional.

We additionally call `guardrails.register()` directly from `healthcare_ext/__init__.py` as a
belt-and-suspenders measure, not because the entry point failed: `config/agent.yaml`'s
`tools.custom: [{module: healthcare_ext.tools}]` always imports `healthcare_ext.tools`, and importing
any submodule of a package runs that package's `__init__.py` first. That gives us a second,
zero-cost guarantee that "phi_redaction" is registered even in an environment where entry-point
discovery has friction (e.g. a raw `PYTHONPATH` import instead of a real package install --
`importlib.metadata.entry_points()` only sees packages with installed dist-info metadata).
`GuardrailRegistry.register()` is a plain dict assignment, so calling it twice is harmless.

## Known limitations (worth being honest about)

- **Guardrail "redaction" doesn't retroactively touch already-streamed text.** `AgentCore.run_stream`
  (`koboi/loop.py`) yields `TextDeltaEvent`s live, token-by-token, as the LLM generates them --
  output guardrails only run afterward, on the complete response (`_process_output`). By the time
  `PHIRedactionGuardrail` flags a match, the raw text has already reached the browser as `text_delta`
  events. What the guardrail *can* affect: the assistant message saved to conversation memory, and the
  final `complete` SSE event's `content` field, both of which get a `[GUARDRAIL WARNING (...): reason]`
  prefix (not silent redaction -- `GuardrailResult.sanitized_content` is populated but not consumed
  anywhere in the current output pipeline; same is true of the built-in `OutputGuardrail`). This matches
  `docs/04`'s own framing that redaction protects logs/traces, not the live conversation the patient
  sees -- but it's worth being precise that today it doesn't even fully protect the *stored* text from
  having already streamed live.
- **No clinician summary view.** `docs/04` describes a second, internal page that reads
  `/data/escalations.log` for a nurse to review. The task's file tree for this app (`frontend/index.html`,
  `app.js`, `Dockerfile` -- one page) scoped that out; only the patient-facing chat is built. Nothing
  prevents adding a second static page that reads the same log later.
- **`auth_required: false`.** Simplified for this local smoke-test POC per the task brief; a real
  deployment would set this `true` and provision a token via `docker compose run --rm koboi koboi keys
  create --label prod`, then have the frontend send `Authorization: Bearer <token>`.
- **Tracing is left off entirely** (no `tracing:` block), per `docs/04`'s own reasoning: free-text
  symptom answers can carry PHI a regex guardrail won't catch, so this deployment ships with tracing off
  rather than trying to scope it down after the fact.
- **`koboi-data` volume is unencrypted**, same as every other use case in this repo -- it holds
  conversation history, which for this app is patient health information. Encryption/access control is
  the operator's responsibility, not something koboi or this app does automatically.

## E2E test (what was actually run, against real Docker + a real LLM)

```bash
cd healthcare-intake
docker compose build          # both images build clean
docker compose up -d
curl -sf http://localhost:8004/healthz    # {"status":"ok"}
curl -sf http://localhost:8004/readyz     # {"status":"ok","checks":[...pool ok, db ok...]}
curl -s -N -X POST http://localhost:8004/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message": "I have had a fever and cough for 3 days"}'
docker compose exec koboi cat /data/escalations.log
docker compose down
```

**Routine symptom** ("fever and cough for 3 days" -- named as a non-escalation example in
`red_flag_symptoms.md`): response is grounded in the seed docs (asks the exact numbered questions from
`intake_questions.md`, explicitly reasons "does not by itself match an urgent escalation pattern" using
`red_flag_symptoms.md`'s own vocabulary), `tools_used: []`, stream ends in a `complete` event, and
`cat /data/escalations.log` returns `No such file or directory` -- the file is never created because
`flag_urgent_escalation` never ran. Matches the task's acceptance criteria exactly.

**Red-flag symptom** (tested beyond the required recipe, to prove escalation actually works and isn't
just "never fires"): "crushing chest pain and I cannot catch my breath, it started 10 minutes ago" -->
`tool_call` for `flag_urgent_escalation` with `reason: "Chest pain with shortness of breath for 10
minutes"`, `tool_result: "Flagged for clinician review."`, no `pending_approval` event (silent, per
doc/04), `complete` content tells the patient to call emergency services, and
`docker compose exec koboi cat /data/escalations.log` then returns exactly
`Chest pain with shortness of breath for 10 minutes`. This test is what surfaced deviation #0 above (it
failed with a mode-blocked error under the originally-specified `mode: chat`, before the `mode: act` fix).

**PHI guardrail** (tested beyond the required recipe): asking the assistant to repeat back a phone number
produced `complete` content `"[GUARDRAIL WARNING (PHIRedactionGuardrail): Possible phone number]\n\n555-982-1234"`
-- confirms the guardrail fires on model output as designed, and confirms the "known limitation" above
(the phone number itself is still visible, not silently redacted, because `sanitized_content` isn't
consumed by the pipeline).

**Frontend**: `curl -sf http://localhost:3004/` serves `index.html`; CORS preflight-equivalent check
(`curl` with an `Origin: http://localhost:3004` header) confirmed both
`access-control-allow-origin: http://localhost:3004` and `access-control-expose-headers: X-Session-Id`
are present on `/v1/chat/stream` responses.
