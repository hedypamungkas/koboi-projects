# ISSUES.md — stability deep-dive for the `koboi-projects` release

Reproducible, evidence-backed findings from the post-release deep-dive across the quickstart installer, all 10 use cases' Python runtime, and their config / frontend / docker layers. Severity: **P0** breaks install / data loss / security · **P1** wrong behavior in a real edge case · **P2** polish / latent.

Each finding has a **trigger** and a **1-line repro** (run from the repo root unless noted). Fixes are applied on branch `fix/stability-hardening`; every fix is paired with the repro that went RED → GREEN.

> Baseline: all 12 configs parse via `Config.from_yaml` (koboi 0.18.x venv). The repo currently ships **zero** automated tests — `TEST.md` is manual-only. That is the single biggest reliability gap and is closed by the Layer-1 pytest harness added in this pass.

---

## P0 — installer (3)

### P0-1 · `--project` with no value hangs the installer in an infinite loop
- **Where:** `quickstart.sh:467` — `--project) PROJECT_FLAG="${2:-}"; shift 2;;`
- **Trigger:** `bash quickstart.sh --project` (or `--project --no-color` typo).
- **Why:** only 1 arg remains, `shift 2` fails (`shift count out of range`), `set -e` is OFF, so the `while` loop re-matches `--project` forever.
- **Repro:** `bash quickstart.sh --project` → hangs until Ctrl-C.
- **Fix:** `--project` requires a value: `[ $# -ge 2 ] || die "--project requires a project name (try --list)"`.

### P0-2 · PowerShell prints a false "Docker OK." on a stopped daemon
- **Where:** `quickstart.ps1:31-32` — `try { docker info *> $null } catch { Write-Err "Docker daemon not running..." }`
- **Why:** under `$ErrorActionPreference = "Stop"`, a native exe (docker.exe) that exits nonzero does **not** throw — only PowerShell cmdlet errors do. A stopped daemon returns 1 quietly; the `catch` never fires.
- **Repro:** stop Docker Desktop on Windows, run `irm <url> | iex` → output shows "Docker OK." then a later downstream failure.
- **Fix:** `docker info *> $null 2>&1; if ($LASTEXITCODE -ne 0) { Write-Err "..." }`.

### P0-3 · `--no-color` / `--no-utf8` flags are dead (parsed after colors are baked in)
- **Where:** `quickstart.sh:41-56` (color/glyph init) vs `:469-470` (flag parse).
- **Why:** the color/glyph blocks run unconditionally at lines 41-56, before the dispatch loop. Later `export NO_COLOR=1` cannot retroactively re-evaluate them. `--help` advertises both flags.
- **Repro:** `bash quickstart.sh --no-color --list | cat -v` still emits `^[[1m`/`^[[36m`; `--no-utf8 --list` still emits `→`/`●` bytes.
- **Fix:** pre-scan `$@` for `--no-color`/`--no-utf8` before line 41.

---

## P1 — installer (8)

- **P1-1 Orphaned lock after `monitor [n]ew project`** — `quickstart.sh:143-152,350`. `LOCKDIR` is a single global reassigned on every `acq_lock`; the EXIT trap `rmdir`s only the last. Pick project A → `[n]ew` → B → quit → A's lockdir is orphaned → next `--project A` falsely dies "another quickstart is already managing 'A'". *Repro:* `bash quickstart.sh` → 1 → `n` → 2 → `q`; then `--project ecommerce-support --yes`. *Fix:* track acquired lockdirs in an array; `rmdir` all in `cleanup`; also trap HUP and write a PID file checked via `kill -0`.
- **P1-2 `curl` missing → everything falsely "unhealthy" + headless abort** — `:176` (preflight only `warn`s) vs `:134/292/422` (unconditional curl). With curl absent each probe returns 000 → `project_state` labels running containers unhealthy; headless mode then trips the `$log` abort (see A). *Repro:* strip curl from PATH, run `--project hr-screening --yes`. *Fix:* short-circuit `wait_health`/probe when curl absent, or make curl a hard prereq.
- **P1-3 Host-process port occupancy missed** — `:129` `port_holder` inspects only Docker containers; a non-Docker process on the port passes silently, then `compose up` fails late after a multi-minute build. *Repro:* `python3 -m http.server 8001 &` then `--project ecommerce-support --yes`. *Fix:* add a host-port probe (`lsof`/curl) to the pre-check.
- **P1-4 `curl|bash` / `irm|iex` execute truncated downloads** — `:4/190` + `ps1:14/41`. No checksum/size/syntax check; a partial response is executed verbatim. *Fix:* download to tempfile, `bash -n` + min-size check, then `exec`.
- **P1-5 Bare key line corrupts `.env`** — `:229-236`. A line with no `=` becomes `FOO=FOO` (both `%%=*` and `#*=` return the whole string). *Repro:* add bare `EXTRA_FLAG` to `.env.example`, run `--yes`. *Fix:* skip/prompt lines where `[[ "$line" != *=* ]]`.
- **P1-6 `chmod 600 … || true` silently fails on FAT/network mounts → secrets world-readable** — `:252`. The follow-up `ok "Wrote .env"` claims success regardless. *Fix:* read the mode back; `warn`/`die` if it isn't 600 on a FS holding secrets.
- **P1-7 PowerShell hand-off quoting footgun** — `ps1:41/52/71`. URL string-interpolated into `bash -lc`; shell metachars in `$env:KOBOI_UC_RAW` are interpreted by bash. *Fix:* pass the URL via env (`WSLENV`), not `-lc`.
- **P1-8 Unbound `$log` in `handle_unhealthy` (headless)** — `:~315`. `log` is only `local` in `up_project`/`spinner`; under `set -u` the script aborts instead of clean `exit 1`. *Repro:* `bash -c 'set -uo pipefail; f(){ printf "%s" "$log"; }; f'` → `unbound variable`. *Fix:* pass `log` as an arg or default `${log:-…}`.

## P1 — installer (already-proven, also fixed)
- **A.** `banner()` (`:485-487`) + literal `–/—/…/→` in messages are not guarded by `is_utf8()` → mojibake under `KOBOI_NO_UTF8=1`. *Repro:* `KOBOI_NO_UTF8=1 LC_ALL=C bash quickstart.sh --list | cat -v`.

### P2 — installer (selection)
`--yes` w/o `--project` opaque die (+ dead `YES` var); `mask()` truncates keys containing `=` (`cut -d= -f2`); silent `mkdir -p`/`git`/`tar` failures (stderr discarded); `cmd_down` ignores unknown trailing tokens and skips the lock; no WSL browser opener; `frontend_port` no lower-bound guard; `ps1:63` `.replace('quickstart.sh','quickstart.ps1')` footgun for forks; `display name "koboi-use-cases"` vs repo `koboi-projects`.

---

## P1 — Python runtime (6)

- **C · customer-success `score_churn_risk` sign bug** — `src/cs_ext/tools.py:122-128`. `trend_pct = int(trend.rstrip("%+-"))` keeps the sign, so `if trend.startswith("-") and trend_pct >= 10` is **always False** (the branch is dead — `startswith("-")` ⇒ `trend_pct ≤ 0`, can't be `≥ 10`). `-18%` and `-2%` both score +6; the seed's ACC-7702 (`-18%`) is mis-scored, and this feeds the consensus-voted churn answer. *Repro:* `score_churn_risk("ACC-7702")` factors never include "active users down …". *Fix:* `abs(trend_pct) >= 10` (or `<= -10`).
- **D · insurance-claims total-loss safety net (defense-in-depth)** — `config/agent.yaml:127-134`. The earlier audit hypothesized the `policy.rules` glob `*total loss*` was case-sensitive; **that was wrong** — `koboi/harness/policy.py` `fnmatch`s on lowered values, so the policy gate already denies `Total Loss`/`TOTAL LOSS` case-insensitively. There is no bypass. An in-tool case-insensitive check in `record_recommendation` is kept as a secondary net so a future config/policy change can't silently unmask this safety-critical path. (Verified against the koboi source during PR review.)
- **E · healthcare-intake escalation log injection** — `src/healthcare_ext/tools.py:33-37`. `flag_urgent_escalation` writes raw LLM/patient `reason` into a nurse's review log with no newline/length sanitization → can forge entries in a safety-critical queue. *Fix:* `reason.replace("\n"," ").strip()[:N]` or JSON-wrap each row.
- **F · real-estate shared in-memory drafts** — `src/realestate_ext/tools.py:110-111`. `_LISTING_DRAFTS`/`_EMAIL_DRAFTS` are module-level mutable globals shared across pooled jobs under `max_concurrent:5` + `delegate_tasks` → silent last-write-wins loss, cross-session leak, non-durable despite the "saved to CRM" message. *Fix:* persist to file (atomic) and/or namespace by session.
- **G · finance-reconciliation import-time `makedirs`** — `src/finance_ext/hooks.py:40`. `os.makedirs(...)` at import time → container fails to boot if `/data/audit` isn't writable on first import (init/volume race). *Fix:* move into `execute()`/`__init__`, guarded.
- **H · hr-screening import-time `build_app()`** — `src/hr_ext/entrypoint.py:72`. `app = build_app()` at module top level → crash-loop on missing config / unset `${OPENAI_API_KEY}`; inconsistent with finance's lazy pattern. *Fix:* move into `main()`.

### P2 — Python runtime (high blast-radius, also fixed)
Widespread `return f"Error: …"` as normal tool output (CS, finance MCP, hr, insurance, real-estate) — no programmatic error signal; audit/recommendation/escalation logs written without `fsync`/lock under thread fan-out (finance most exposed via `to_thread`) → rows > 4096B can interleave; time-based ID collisions (`int(time.time())` in concierge tools + open_ticket); numeric input gaps (`initiate_refund`, `post_journal_entry`, `record_recommendation` accept neg/zero/NaN/Inf — `record_recommendation` is SAFE and ungated, and `json.dumps` emits invalid `NaN`/`Infinity`).

### Robust (low effort needed)
`ecommerce-support`, `legal-contract-review` (tools), `employee-concierge` agent tools, `market-intel` (config-only — no use-case Python).

---

## P1 — config / frontend / docker (1 XSS + 4)

- **XSS · real-estate dashboard** (borderline P0) — `frontend/app.js:295-298`. `detail.innerHTML` interpolates the LLM-generated job `content` (draft listings/emails) **RAW**; **no `escapeHtml` is defined in the file at all.** Reachable via prompt-injection in property/lead data → `<img onerror=…>` executes in the dashboard. (Also `:271-276` raw `job_id`/`status`.) *Repro:* craft a property description `<img src=x onerror=alert(1)>`; LLM drafts it into a listing; dashboard renders it. *Fix:* add `escapeHtml` (copy from legal/healthcare) and wrap, or use `textContent`.
- **No compose healthchecks (all 10)** — `/healthz` exists but no `docker-compose.yml` defines `healthcheck:` and none use `depends_on: { condition: service_healthy }`; `up -d` + immediate frontend load races the koboi boot (5-10s). *Fix:* add `healthcheck` + readiness condition to all 10.
- **Every container runs as root** — no `USER` in any Dockerfile (+ `auth_required:false` on 7/10 ⇒ unauth root on escape). *Fix:* non-root `USER app` + `chown /app /data`.
- **employee-concierge auth-key coupling** — `concierge.yaml:136` `api_keys:["${CONCIERGE_API_KEY}"]` (no default) survives env-substitution as the **literal string** (koboi preserves unset `${VAR}` rather than crashing — `koboi/config.py:21-27`) ⇒ backend rejects the frontend's hardcoded `concierge-smoke-key-1234` ⇒ opaque 401. *Fix:* `${CONCIERGE_API_KEY:concierge-smoke-key-1234}` default.
- **market-intel timeout inversion** — frontend `STREAM_TIMEOUT_MS=240_000` (4m) < `llm.timeout:300` (5m); a live-chat deep_research > 4m is cut by the client while the backend keeps working. *Fix:* align client timeout ≥ `llm.timeout`+headroom.

### P2 — config / frontend / docker (selection)
Base images unpinned by digest (`python:3.12-slim`/`nginx:alpine` mutable); `${OPENAI_API_KEY}/${OPENAI_MODEL}` no-default → preserved as literal → late confusing 401 (8 use cases); `jobs.webhooks[*].url: http://localhost:9999/...` unreachable from inside the container (CS, insurance, market-intel); wildcard CORS + open auth on 5/10 (ecommerce, hr, legal, real-estate, +concierge peers); `koboi-agent>=0.18.2` in pyproject (ecommerce/legal/healthcare) undermines the `==0.18.2` Dockerfile pin; sandbox-hardening inconsistency (CS + insurance skip `rlimits`/`git_init` that finance/hr set); **legal `jobs.enabled:true` with no `sandbox.backend:restricted` ⇒ any `POST /v1/jobs` raises `PermissionError`** (latent); no `.dockerignore` anywhere; employee-concierge shell-form `CMD koboi serve` (sh=PID1, SIGTERM→SIGKILL); inconsistent config-env-var names; stale insurance compose comment "(orchestrated DAG)"; hr `onclick` raw `job_id`; polling never pauses on `document.hidden`.

### Memory correction
The prior note that `hr output_schema` is a no-op is **stale** — it isn't in the current config at all (structured-output is enforced via system prompt + frontend tolerance). Nothing to do; do not re-add it.

### Robust frontends (models to copy)
`legal-contract-review` (zero innerHTML, pure textContent + `document.createElement`) and `healthcare-intake` (best error diagnostics, screen-reader live region, scoped CORS) — use as the escaping/error-pattern references.

---

## Fix map (finding → Phase-2 pattern)
C→input-validation · D→policy/validation · E→log-injection+frontend-escape · F→atomic-persistence · G→io-hygiene/entrypoint · H→entrypoint · XSS→frontend · healthcheck/non-root/pin→config&docker · auth-key→config · timeout→frontend · env-literal→env-failfast · webhook→config · audit-fsync/lock→persistence · errors-as-strings→surface-errors · ID-collisions→validation · numeric→validation.

---

## Status — fixed in this pass (branch `fix/stability-hardening`)

**Fixed + proven (repro goes RED→GREEN, codified as pytest):**
- Installer P0s: `--project`-no-value hang, dead `--no-color`/`--no-utf8` flags, ps1 false "Docker OK" (`$LASTEXITCODE`); `$log`/`banner()` UTF-8; orphaned-lock-on-`[n]ew` (array + PID + HUP trap); curl-missing short-circuit; host-port probe; bare-key `.env`; chmod-600 verify; `--yes` w/o `--project`; `mask()`/`frontend_port` edges; ps1 URL-via-env. (`tests/test_installer.py`, `shellcheck -S warning` clean.)
- Runtime P1s: C (CS churn sign), D (insurance total-loss in-tool guard), E (healthcare escalation sanitize), F (real-estate durable locked JSONL drafts), G (finance lazy makedirs + audit lock), H (hr lazy `build_app`), plus the proven hr concurrency/atomic-write/quarantine (#3), hr score validation, insurance None-handling + amount validation, CS `flag_at_risk` sanitize, concierge ID collisions + stable hash. (`tests/test_{hr,customer_success,healthcare,real_estate,insurance,finance,entrypoints}.py`.)
- Frontend: real-estate XSS (`escapeHtml` + every dynamic sink wrapped), hr `onclick`→data-attributes, market-intel timeout aligned (330s ≥ `llm.timeout`). (`test_cross_cutting.test_frontend_no_raw_innerhtml_sink` scans all 10.)
- Config/docker: 10/10 compose `healthcheck` + `depends_on: service_healthy`; 10/10 backend Dockerfiles non-root `USER app` + `/data/.dockerkeep`; **`.dockerignore` in EACH use-case dir** (the build-context root — a repo-root file is never consulted, so per-use-case `.env` was leaking into build context); concierge auth-key default + front-door `sandbox:restricted`; legal `sandbox:restricted`; CS + insurance `rlimits`+`git_init`; `koboi-agent==0.18.2` pin (ecommerce/legal/healthcare); webhook URLs `host.docker.internal` + `extra_hosts: host-gateway` for Linux (CS/insurance/market-intel); docs/00 "6 apps"→"10 apps"; insurance compose "(DAG)"→"(single-agent)". (`test_cross_cutting` parameterized over all 10.)

**Intentionally NOT changed (re-assessed as correct/low-value):**
- **Concierge shell-form `CMD`** (P2): the single image is shared by 3 services and `${KOBOI_CONFIG:-concierge}.yaml` selects each config — shell expansion that exec-form can't do. The signal-handling tradeoff is accepted.
- **`server.auth_required: false` + wildcard CORS** on 5/10: documented local-POC simplification (every config comments it); production guidance is in each README. Not changed to avoid breaking the local demo.
- **`return f"Error: …"` as tool output**: pervasive but consistent (the LLM treats it as data and self-corrects); a wholesale `ToolError` refactor is P2 polish with regression surface — deferred.
- **`initiate_refund` / `post_journal_entry` numeric validation**: both are `DESTRUCTIVE` (human-approval-gated), so a bad amount is caught by the approver — low impact, deferred.

**Test harness:** `tests/` (119 tests, <2s, no Docker/LLM) — run with `../koboi-agent/.venv/bin/python -m pytest -q`. Layer-1 in `TEST.md` now points here.
