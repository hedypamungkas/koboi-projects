# TEST.md — reproducing the manual verification pass across all 10 use cases

This is a runbook, not a test suite. It captures the exact real scenarios (layered checks + backend `curl`
calls + live-browser click-throughs) that were used to verify all 10 `koboi-use-cases` apps end to end, so a
human or an AI agent can repeat the same pass later — after a koboi-agent upgrade, a redesign, or just to
confirm nothing regressed. There is no automated test runner here; every app is a demo, and "testing" means
actually running it against a real LLM and watching the real output.

Testing here is **layered** (see "Testing in layers" below): a fast no-container pass (config schema + Python
compile/import) catches most regressions in seconds, an integration pass confirms each stack boots, and only
then does the slow, real-LLM end-to-end pass run. Run the layers in order — stop at the first broken layer.

## How to use this doc

- **Human tester**: follow the "Backend smoke test" curl blocks verbatim, then do the "Browser
  walkthrough" steps by hand in an actual browser.
- **AI agent** (e.g. via `claude-in-chrome` or similar browser tools): the "Browser walkthrough" steps
  are written as a numbered click/type/wait script — precise enough to execute directly. Each step names
  the exact element (button label, chip text, or CSS id) to interact with.
- Test **one project at a time**. Each app's backend binds fixed host ports (see table below), but running
  more than one koboi container simultaneously has not been a problem in practice if you do want to
  parallelize — just watch total LLM request concurrency against your gateway/quota.
- Always `docker compose down` a project before moving to the next, so stopped-but-not-removed containers
  don't accumulate.

## Newly-adopted 0.18 features (this pass)

A fit-mapping pass identified four real, wired koboi 0.18.x features that no use case exercised, each with a
domain-driven fit. All four are now adopted, layered-verified (Layers 1-3 below), and documented in the
relevant project README's "Deviations" section.

| # | Feature (config knob) | Use case | What it does here | Verification signal |
|---|---|---|---|---|
| 1 | `self_healing.critic_llm` + `providers:` | `insurance-claims`, `customer-success` | Routes the self-healing CRITIC (insurance `tool_verification`, CS `self_consistency`) to a distinct named client so the verifier is decoupled from the answering model. Fail-soft (`koboi/facade.py:1454`). | Layer 2: no `critic_llm resolve/build failed` warning at boot. Layer 3: CLM-501 still → `record_recommendation` (amount persisted). |
| 2 | `rag.rerank` + `query_rewrite` + `hyde` | `healthcare-intake` | Heuristic rerank + LLM query rewrite + HyDE on the hybrid retriever (reuses the chat client, no new key — `koboi/rag/registry.py:486-489`). Clinical symptom→protocol retrieval is where these earn their keep. | Layer 3: "sharp chest pain when I breathe" lifts the red-flag protocol → `flag_urgent_escalation` fires (see `/data/escalations.log`). |
| 3 | `peers.org_secret` verified-A2A | `employee-concierge` (all 3 configs) | Shared HMAC secret makes each peer prove same-org membership via its signed agent-card before it's callable. `verify_all` is **non-fatal** — an unverified peer is dropped + warned, not a boot crash (`koboi/server/peers.py:139-160`). `A2A_ORG_SECRET` added to `.env`/`.env.example`. | Layer 2: each peer's `/.well-known/agent-card` HMAC-verifies True. Layer 3: `call_peer_agent` → peer-it `POST /v1/peer/invoke 200 OK`. |
| 4 | `sandbox.git_init` + `sandbox.rlimits` | `hr-screening`, `finance-reconciliation` | `git_init` seeds each jobs workdir as a git repo (audit trail); `rlimits` = POSIX caps on sandboxed subprocess children. `git` added to both `backend/Dockerfile`s. | Layer 2: `git --version` works in-container; config loads `git_init=True` + rlimits. (seccomp intentionally NOT used — these tools are in-process, so seccomp has no runtime surface.) |

Notes / honest caveats:
- **Rec 1 critic points at the same gateway/model as the chat LLM** (no second key needed for the demo). The
  value of a *separate* critic is fully realized in production by pointing `providers.critic` at a stronger
  model — the wiring is identical.
- **Rec 4 rlimits are defense-in-depth here**: `fetch_resume`/`score_candidate`/`post_journal_entry` run
  in-process (no subprocess), and the finance ERP MCP server is a persistent (non-sandboxed) stdio child. So
  `rlimits`/seccomp apply to no current code path; they earn teeth with a future shell/code-exec tool. `git_init`
  is the one piece with real effect today (it seeds the workdir repo on every job).
- The deeper runtime confirmation of rerank (the `retrieval_method` stamp, e.g. `rerank:heuristic`, in
  `complete.metadata.rag_results`) is a future check; Layers 1-3 here prove config + wiring + correct behavior.

## Testing in layers

Run these in order. Each layer is progressively slower and more expensive (real LLM calls); stop at the
first failure. The scripts below assume the sibling koboi-agent venv at `../koboi-agent/.venv/bin/python`
(any environment with `koboi-agent==0.18.2` installed works).

### Layer 1 — mock / unit (no containers, no LLM, ~2s)

Catches the vast majority of regressions: a config that won't parse, a `@tool` with a bad JSON-schema, a
syntax error. Run from the repo root with the env vars the `${...}` placeholders expect:

```bash
export OPENAI_API_KEY=sk OPENAI_MODEL=m OPENAI_BASE_URL=http://x EMBEDDING_API_KEY=sk EMBEDDING_BASE_URL=http://x \
  CLAIMS_WEBHOOK_URL=http://x CLAIMS_WEBHOOK_SECRET=s BRIEF_WEBHOOK_URL=http://x BRIEF_WEBHOOK_SECRET=s \
  CRM_WEBHOOK_URL=http://x CRM_WEBHOOK_SECRET=s WEB_SEARCH_PROVIDER=mock WEB_FETCH_PROVIDER=httpx \
  BRAVE_API_KEY=b FIRECRAWL_API_KEY=f PEER_IT_URL=http://x PEER_FACILITIES_URL=http://x \
  PEER_IT_TOKEN=t PEER_FACILITIES_TOKEN=t CONCIERGE_API_KEY=k A2A_ORG_SECRET=d
PY=../koboi-agent/.venv/bin/python

# 1a. every config parses against Config.from_yaml (koboi 0.18.2 strict schema)
$PY - <<'EOF'
import glob; from koboi.config import Config
for p in sorted(glob.glob("*/config/*.yaml")):
    Config.from_yaml(p); print("PASS", p)
EOF

# 1b. every extension .py compiles
find . -path ./node_modules -prune -o -name '*.py' -not -path '*/__pycache__/*' -print \
  | xargs $PY -m py_compile && echo "all .py compile"

# 1c. each ext module imports (@tool decorators run) + the command-hook script runs standalone
for mp in "insurance-claims/src:claims_ext.tools" "employee-concierge/src:concierge_ext.it_tools" \
          "employee-concierge/src:concierge_ext.facilities_tools" "customer-success/src:cs_ext.tools"; do
  PYTHONPATH="${mp%%:*}" $PY -c "import importlib; importlib.import_module('${mp##*:}')"
done
echo '{"event":"post_output","session_id":"s","output":"x"}' \
  | CONCIERGE_TICKETS_LOG=/tmp/t.jsonl $PY employee-concierge/scripts/open_ticket.py
```
Expect: 12 configs PASS, all `.py` compile, all imports succeed, a ticket row written. (`market-intel` has
no `src/` — it's config-only — so it's absent from 1c on purpose.)

### Layer 2 — integration (each stack boots, ~10s each)

Confirms the Docker wiring, config boot, and (for UC9) the 3-container A2A topology + auth gate come up.

```bash
cd <project-dir> && docker compose up -d && sleep 4
curl -sf http://localhost:<backend-port>/healthz        # {"status":"ok"}
curl -sf http://localhost:<backend-port>/readyz          # 200
docker compose logs koboi | grep -iE 'error|traceback'   # expect nothing
docker compose down
```
UC9 (`employee-concierge`) boots 3 containers — bring peers up first, then the concierge, and confirm all
three `readyz` plus the A2A auth gate (`/v1/chat/stream` returns **401** with no token, **200** with
`Authorization: Bearer $CONCIERGE_API_KEY`).

### Layer 3 — end-to-end (real LLM, the scenarios below)

Only this layer calls the LLM. It's the per-project "Backend smoke test" (curl) + "Browser walkthrough"
(Chrome DevTools MCP or by hand) in each section below. **Known gateway behavior** (empty completions,
slow deep-research) applies — read that section before calling anything broken.

> **Frontend rebuild gotcha:** the web image bakes `index.html`/`app.js` in at build time. After editing
> frontend source you MUST `docker compose build web && docker compose up -d --force-recreate web` — a bare
> `up -d` serves the stale old image. (This bit UC1/UC3 mid-pass; rebuilt + re-verified.)

## One-time setup (per project)

Every project needs its own `.env` (never commit it — it's gitignored):

```bash
cd <project-dir>          # e.g. ecommerce-support
cp .env.example .env
# edit .env: set OPENAI_API_KEY (and OPENAI_MODEL / OPENAI_BASE_URL if you're not using
# the default OpenAI endpoint — all 10 apps were last verified against gpt-5.4-mini via a
# custom OpenAI-compatible gateway, see "Known gateway behavior" below)
```

| # | Project | Backend | Frontend | Style |
|---|---|---|---|---|
| 1 | `ecommerce-support` | `:8001` | `:3001` | chat + refund approval |
| 2 | `hr-screening` | `:8002` | `:3002` | jobs + polling dashboard (no chat UI) |
| 3 | `finance-reconciliation` | `:8003` | `:3003` | chat + MCP + approval |
| 4 | `healthcare-intake` | `:8004` | `:3004` | chat only |
| 5 | `legal-contract-review` | `:8005` | `:3005` | review form + chat + approval |
| 6 | `real-estate` | `:8006` | `:3006` | tabbed chat + jobs dashboard |
| 7 | `insurance-claims` | `:8007` | `:3007` | chat triage (self-healing + handover + policy) |
| 8 | `market-intel` | `:8008` | `:3008` | deep-research briefs (config-only, no `src/`) |
| 9 | `employee-concierge` | `:8009` (+peers `:8011`,`:8012`) | `:3009` | A2A concierge — **3 containers, auth required** |
| 10 | `customer-success` | `:8010` | `:3010` | chat + vitals readout + HITL authorization |

Generic lifecycle for any project:

```bash
cd <project-dir>
docker compose build
docker compose up -d
sleep 4
curl -sf http://localhost:<backend-port>/healthz   # expect {"status":"ok"}
# ... run that project's scenario below ...
docker compose down
```

## Known gateway behavior — read this before filing a bug

During this pass, `gpt-5.4-mini` (via the `surplusintelligence.ai` gateway used for testing)
intermittently returned a **fast (~10s) but completely empty completion** — no text, no tool call — for an
otherwise normal request. This was reproduced against multiple, unrelated projects with identical
payloads that succeeded correctly on the very next retry. It is **gateway/model nondeterminism, not a
koboi or app bug** (confirmed by replaying the exact request koboi sent directly against the gateway and
watching it succeed).

**If a chat response comes back blank or a scenario below doesn't match:**
1. Retry the exact same message once or twice before concluding anything is broken.
2. All 5 chat-based frontends now show a friendly fallback line ("Sorry, I didn't get a response there —
   try asking again") instead of a silently blank bubble when this happens, and every `streamChat()` call
   times out after 90s instead of hanging forever if a connection genuinely stalls. If you see a raw blank
   bubble with no fallback text at all, or a spinner that never clears after 90s+, *that* is a real
   regression worth reporting — check `docker compose logs koboi` and that project's `.logs/*.log` file
   inside the container first (see `docker exec <container> cat /app/.logs/*.log` for the exact
   request/response koboi sent).

## 1. `ecommerce-support` — Anvil & Co support widget

**Backend smoke test:**
```bash
cd ecommerce-support && docker compose build && docker compose up -d && sleep 4
curl -sf http://localhost:8001/healthz
curl -s -N -X POST http://localhost:8001/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message": "Where is my order #10234 and can I return it?"}'
```
Expect a `tool_call` for `lookup_order` (and/or `check_return_eligibility`), then `text_delta`s, then
`complete` — no approval needed for read-only lookups.

**Browser walkthrough** (`http://localhost:3001`):
1. Type `I'd like a refund for order #10234, it arrived damaged` into the chat input, press Enter.
2. Watch the status bubble change to "Checking your order..." then "Checking your refund..." as tool
   calls happen.
3. A refund approval card should appear in the right-hand approvals panel showing the parsed amount,
   order id, and reason (`initiate_refund` is `RiskLevel.DESTRUCTIVE`).
4. Click **Approve** — the card is removed and a status bubble reads "Refund approved by support --
   processing now." Click **Reject** on a different run instead to confirm the deny path shows "Refund
   rejected by support."
5. Confirm the agent's final chat bubble summarizes the outcome.

## 2. `hr-screening` — Northstar Talent recruiter dashboard

No chat UI — this app is jobs-only (`POST /v1/jobs` + polling), per its README.

**Backend smoke test:**
```bash
cd hr-screening && docker compose build && docker compose up -d && sleep 4
curl -sf http://localhost:8002/healthz
JOB=$(curl -s -X POST http://localhost:8002/v1/jobs -H "Content-Type: application/json" \
  -d '{"message": "Score resume R-001 against the Senior Backend Engineer requisition"}')
JOB_ID=$(echo "$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin)['job_id'])")
for i in $(seq 1 20); do
  STATUS=$(curl -s http://localhost:8002/v1/jobs/$JOB_ID)
  echo "$STATUS" | grep -q '"status":"completed"' && break
  sleep 2
done
docker compose exec koboi cat /data/audit/scoring_audit.jsonl
```
Expect the job to complete with a JSON `result.content` of `{resume_id, score, rationale, recommendation}`.

**Browser walkthrough** (`http://localhost:3002`):
1. Enter `R-001` in the resume-id field and click **Submit** (repeat for `R-002`, `R-003`, `R-004` — the
   4 sample resumes hardcoded in `tools.py`).
2. Within ~10-15s the results table should populate with a new row per resume: candidate avatar, a
   score-ring badge, a recommendation pill (`Strong match` / `Possible match` / `Weak match`), and a
   rationale.
3. Click **Approve** or **Pass** on a row and confirm it becomes a static "Approved for interview" /
   "Passed" chip (this is a local recruiter decision, not sent back to koboi).

## 3. `finance-reconciliation` — Ledgerline controller dashboard

**Backend smoke test:**
```bash
cd finance-reconciliation && docker compose build && docker compose up -d && sleep 4
curl -sf http://localhost:8003/healthz
curl -s -N -X POST http://localhost:8003/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message": "Run a three-way match on invoice INV-8842 against PO PO-4471", "mode": "act"}'
# grab the X-Session-Id response header, then:
curl -s -N -X POST http://localhost:8003/v1/chat/stream -H "Content-Type: application/json" \
  -H "X-Session-Id: <id-from-above>" -d '{"message": "post that entry to GL account 5000", "mode": "act"}'
```
Expect the first call to show `tool_call`/`tool_result` for `three_way_match` (proves the MCP stdio
subprocess started) then `complete`. Expect the second call to emit `pending_approval` for
`post_journal_entry` (`RiskLevel.DESTRUCTIVE`). Resolve it:
```bash
curl -s -X POST http://localhost:8003/v1/sessions/<session-id>/approve -H "Content-Type: application/json" \
  -d '{"approval_id": "<approval-id>", "decision": "approve", "scope": "once"}'
```
The still-open second `curl -N` call then finishes with a `tool_result` like `"Posted 4200 to 5000 for
invoice INV-8842 (mock -- no real ERP)."`.

**Browser walkthrough** (`http://localhost:3003`):
1. Click one of the flagged-invoice cards in the left panel (e.g. `INV-9104`) — it prefills the chat
   input with `Run a three-way match on invoice INV-9104 against PO PO-5610`. Press Enter.
2. Watch `-> calling three_way_match(...)` / `<- three_way_match result: ...` tool messages appear in the
   dark ops-console chat log.
3. Type `post that entry to GL account 5000` — an approval card should render inline in the chat with a
   risk pill (`destructive risk`) and a key/value grid of the tool arguments.
4. Click **Approve** and confirm the card's title gets a `-- approved` suffix and the chat continues with
   a posting confirmation. On a separate run, click **Reject** and confirm the title reads `-- denied`
   (or `-- failed to resolve` if resolution itself errors) instead.
5. Confirm the audit trail recorded it: `docker compose exec koboi cat /data/audit/invoice_audit.jsonl`
   should have a row for the match and the approved posting (a rejected posting should NOT appear —
   koboi resolves DESTRUCTIVE approval before the audit hook runs).

## 4. `healthcare-intake` — Riverside Family Clinic pre-visit chat

**Backend smoke test:**
```bash
cd healthcare-intake && docker compose build && docker compose up -d && sleep 4
curl -sf http://localhost:8004/healthz
curl -s -N -X POST http://localhost:8004/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message": "I have had a fever and cough for 3 days"}'
docker compose exec koboi cat /data/escalations.log   # expect empty/missing for a routine symptom
```

**Browser walkthrough** (`http://localhost:3004`):
1. Type `I've had chest pain and shortness of breath since this morning` and press Enter (or Shift is
   NOT needed to submit — plain Enter submits, Shift+Enter would insert a newline if the textarea
   supported multi-line, per the `keydown` handler).
2. The assistant bubble should stream in progressively, then settle on its final text once `complete`
   fires. This should trigger the urgent-escalation path (no visible UI change for the patient — by
   design, "you've been flagged" is never shown to the patient side).
3. Verify escalation logging: `docker compose exec koboi cat /data/escalations.log` should now have an
   entry.
4. Test a routine case in a fresh session (reload the page) — a mild, non-urgent symptom should NOT add
   to `escalations.log`.
5. Confirm no secrets/PHI patterns leak past the output guardrail (the design doc's threat model) — this
   isn't independently testable via UI alone; check `docker compose logs koboi` for
   `GUARDRAIL WARNING` prefixes if you intentionally try to elicit one.

## 5. `legal-contract-review` — Kessler & Vance clause review workspace

**Backend smoke test:**
```bash
cd legal-contract-review && docker compose build && docker compose up -d && sleep 4
curl -sf http://localhost:8005/healthz
curl -s -N -X POST http://localhost:8005/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message": "Review this clause: Vendor shall indemnify Client for any and all claims without limitation."}'
```
Expect an `[ACTIVATE_SKILL: indemnification-clauses]` marker in an early `text_delta`, then a `tool_call`
for `propose_redline`, then `pending_approval` (`RiskLevel.MODERATE`). Resolve it:
```bash
curl -s -X POST http://localhost:8005/v1/sessions/<session_id>/approve -H "Content-Type: application/json" \
  -d '{"approval_id": "<approval_id>", "decision": "approve"}'
```
The stream resumes and ends in `complete` with `"tools_used":["propose_redline"]`.

For the no-match path:
```bash
curl -s -N -X POST http://localhost:8005/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message": "Review this clause: resolved via binding arbitration under the laws of the Moon."}'
```
Expect `flag_novel_clause` (`RiskLevel.SAFE`) instead — no `pending_approval` step.

**Browser walkthrough** (`http://localhost:3005`):
1. Paste `Vendor shall indemnify Client for any and all claims without limitation.` into the clause
   textarea and click **Review**.
2. The review panel should show a maroon changebar accent and a redline draft appear once approved (see
   step 3), or a "No playbook match -- flagged for lawyer review" banner for an out-of-playbook clause.
3. Approve/reject via the approval card that appears in the approvals list next to the review panel —
   confirm the ink-stamp "Approved"/"Declined" animation plays before the card is removed.
4. Click **Discuss in chat** to carry the same clause into the chat panel below and ask a follow-up, e.g.
   `Why is unlimited indemnification risky for us?` — confirm the session id badge at the top stays the
   same value as the one set during the review step (same session/memory across both panels).
5. Send a message directly in the chat panel too (not via "Discuss in chat") to confirm the standalone
   chat path (`sendChatMessage`) also renders replies and approval cards correctly.

## 6. `real-estate` — Harbor Realty Group listings assistant

**Backend smoke test:**
```bash
cd real-estate && docker compose build && docker compose up -d && sleep 4
curl -sf http://localhost:8006/healthz
curl -s -N -X POST http://localhost:8006/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message": "[listing:P-101] Is this pet friendly?"}'
```
Expect `tool_call` for `lookup_property` then a `complete` answering from `P-101`'s `raw_features`
(pet-friendly, no weight limit). If the message omits `[listing:ID]`, the agent should give a general
answer or ask which listing.

Nightly batch job:
```bash
JOB=$(curl -s -X POST http://localhost:8006/v1/jobs -H "Content-Type: application/json" \
  -d '{"message": "Draft listing descriptions for the 3 new properties and a follow-up email for stale lead L-002", "mode": "act"}')
JOB_ID=$(echo "$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin)['job_id'])")
for i in $(seq 1 20); do
  curl -s http://localhost:8006/v1/jobs/$JOB_ID | grep -q '"status":"completed"' && break; sleep 2
done
```
Expect the job to call `delegate_tasks` (2+ items in one batch) rather than the draft tools directly.

**Browser walkthrough** (`http://localhost:3006`):
1. On the **Buyer chat** tab, with listing `P-101 -- 42 Harbor View` selected, click each quick-question
   chip in turn (`Pet policy`, `Square footage`, `Price`, `What's nearby`) and confirm each renders a
   real, specific answer (not a blank bubble) within ~10-15s.
2. Type a request the buyer chat must refuse: `Can you draft me a new listing description for this
   unit?` — confirm it does **not** call `draft_listing_description` and instead replies with the
   redirect line ("Property descriptions and follow-ups are handled by our team...") — this is the
   dual-audience system prompt's buyer/nightly-job separation working correctly.
3. Switch to the **Agent dashboard** tab (dark "ops console" theme, distinct from the warm buyer-chat
   theme) and click **Run nightly batch now**. After a refresh, a new job row should appear; click it to
   expand the job detail panel and confirm the drafted listing descriptions/follow-up email text shows up
   (never auto-published — this is draft-only).
4. Confirm the stat counters at the top (Total / Pending / Completed / Failed) update to match the job
   list.

## 7. `insurance-claims` — Beacon Mutual claims triage (single-agent, self-healing)

**Backend smoke test:**
```bash
cd insurance-claims && docker compose build && docker compose up -d && sleep 4
curl -sf http://localhost:8007/healthz
curl -s -N -X POST http://localhost:8007/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message":"Triage claim CLM-501 and route it.","mode":"act"}'
```
Expect `tool_call`/`tool_result` for `lookup_claim` → `screen_fraud` (low) → `estimate_repair_cost` ($1,242)
→ `record_recommendation` ("queued for adjuster review"), then `complete`. A total-loss claim
(`CLM-502`) instead routes to `transfer_to_human` (no recommendation recorded):
```bash
curl -s -N -X POST http://localhost:8007/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message":"Triage claim CLM-502 and route it.","mode":"act"}'
docker compose exec koboi cat /data/recommendations.jsonl   # CLM-501 rec, not CLM-502
```

**Browser walkthrough** (`http://localhost:3007` — cream "case-file / ledger" UI):
1. Click the **CLM-501** row in the Intake Ledger — it prefills `Triage claim CLM-501 and route it.`
2. Click **File**. Watch `OF RECORD` entries stream with single ▸/◂ markers (lookup → screen → estimate),
   then a `TRIAGE MEMO` citing collision coverage, then `record_recommendation` recorded.
3. Repeat for **CLM-502** — expect a `transfer_to_human` entry and no recommendation.

## 8. `market-intel` — Northwind cited competitive briefs (deep_research, config-only)

**Backend smoke test** (mock provider runs offline; set `WEB_SEARCH_PROVIDER=firecrawl` + `FIRECRAWL_API_KEY`
for live cited research):
```bash
cd market-intel && docker compose build && docker compose up -d && sleep 4
curl -sf http://localhost:8008/healthz
curl -s -N --max-time 300 -X POST http://localhost:8008/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message":"Research Acme Cloud pricing and product launches this quarter with citations.","mode":"act"}'
```
Expect `search`/`source`/`coverage` orchestration events, then a `complete` with a **cited** brief. With the
mock provider the brief honestly reports "no verifiable results" with numbered citations rather than
inventing facts — that anti-hallucination behavior is the pass signal. (Deep research is slow: a full brief
fans out many searches; the job timeout is 1800s. A `--max-time` under ~180s may cut it off mid-research —
that's latency, not a break.) Autonomous weekly brief job:
```bash
JOB=$(curl -s -X POST http://localhost:8008/v1/jobs -H "Content-Type: application/json" \
  -d '{"message":"Run this week'\''s competitive brief; cite every claim.","mode":"act"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')
curl -s -N "http://localhost:8008/v1/jobs/$JOB/stream"
```

**Browser walkthrough** (`http://localhost:3008` — salmon "broadsheet" UI):
1. Click **Acme Cloud** under "ON THE DOCKET" — prefills `Research Acme Cloud this quarter.`
2. Click **Query**. The brief renders as a newspaper **article** in the brief column: an h3 headline, a
   drop-capped first paragraph, superscript `[1][2]…` citations, and a `## Sources` list.
3. (Optional) click **Dispatch weekly brief** to run the autonomous job and tail its stream into the chat.

## 9. `employee-concierge` — Northwind cross-department A2A (3 containers, auth required)

A2A-enabled servers force auth: the concierge demands `Authorization: Bearer $CONCIERGE_API_KEY` on every
endpoint. The `.env` default is `CONCIERGE_API_KEY=concierge-smoke-key-1234`.

**Backend smoke test:**
```bash
cd employee-concierge && docker compose build
docker compose up -d peer-it peer-facilities && sleep 4
docker compose up -d concierge web
for p in 8011 8012 8009; do curl -sf http://localhost:$p/healthz; done
# auth gate:
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8009/v1/chat/stream \
  -H "Content-Type: application/json" -d '{"message":"hi","mode":"act"}'              # 401
curl -s -N -X POST http://localhost:8009/v1/chat/stream \
  -H "Content-Type: application/json" -H "Authorization: Bearer concierge-smoke-key-1234" \
  -d '{"message":"I am emp-42 and my laptop AST-1001 will not boot. Help.","mode":"act"}'
```
Expect a `call_peer_agent` tool_call to the IT peer and a `tool_result` of `[IT] (OK)` with the peer's
answer (AST-1001 = MacBook Pro 14, troubleshooting steps). Prod-admin is policy-denied at the peer:
```bash
curl -s -N -X POST http://localhost:8009/v1/chat/stream \
  -H "Content-Type: application/json" -H "Authorization: Bearer concierge-smoke-key-1234" \
  -d '{"message":"Grant emp-42 prod-admin access for deploy work.","mode":"act"}'
# expect the IT peer to report the request_access(prod-admin) call was policy-denied
docker compose exec concierge cat /data/tickets.jsonl   # command-hook wrote a ticket per resolution
```

**Browser walkthrough** (`http://localhost:3009` — warm "service portal" UI; the key is sent automatically):
1. Click **Laptop won't boot** (pine-coded IT chip) → **Send**.
2. A **routing card** renders: `Routing → IT desk` (pine) with the focused message, then `IT desk replied ←`
   with the peer's formatted answer. Markdown (`**bold**`, `###`) renders, not literal.
3. Click **Request prod-admin** → expect the policy-denied reply (no access created).
4. Bring peers up before the concierge on restart (compose start-order race; a too-early call falls back to
   `transfer_to_human` and succeeds on retry).

## 10. `customer-success` — account health & renewal (single-agent, HITL)

**Backend smoke test:**
```bash
cd customer-success && docker compose build && docker compose up -d && sleep 4
curl -sf http://localhost:8010/healthz
curl -s -N -X POST http://localhost:8010/v1/chat/stream -H "Content-Type: application/json" \
  -d '{"message":"Score the churn risk for ACC-7702 and recommend an action.","mode":"act"}'
```
Expect `fetch_account_health` → `score_churn_risk` (81 / high) then a `complete` whose content is a single
JSON object `{account_id, churn_risk_score, risk_level, recommended_action, rationale}`. HITL outreach:
```bash
SID=<session-id from the X-Session-Id header above>
curl -s -N -X POST http://localhost:8010/v1/chat/stream -H "Content-Type: application/json" \
  -H "X-Session-Id: $SID" \
  -d '{"message":"Draft an email outreach for ACC-7702 about their usage decline and offer a QBR.","mode":"act"}'
# grab approval_id from the pending_approval event, then (while the stream above is still open):
curl -s -X POST http://localhost:8010/v1/sessions/$SID/approve -H "Content-Type: application/json" \
  -d '{"approval_id":"<id>","decision":"approve","scope":"once"}'
docker compose exec koboi ls /data/outreach/   # the approved draft json
```

**Browser walkthrough** (`http://localhost:3010` — dark "observatory / vitals" UI):
1. Click the **ACC-7702** (high) vitals card → **Analyze**. The structured JSON renders as a **vitals
   readout**: big `81/100` (coral), `HIGH RISK`, `action · escalate to csm`, + the rationale.
2. Type `Draft an email outreach for ACC-7702 about their usage decline and offer a QBR.` → **Analyze**.
3. An **authorization slab** renders (`✎ Authorize draft · FOR-SIGNATURE · MODERATE RISK`, args grid).
   Click **Authorize** → the slab flips to `AUTHORIZED`, and `draft_outreach` reports the draft saved.

## Full regression checklist

Use this as a final pass after any change to shared code (`koboi-agent` version bump, a shared frontend
pattern, docs). Check off each row after confirming it via the scenario above.

| # | Project | Backend healthz | Core chat/job flow | Approval flow (if any) | Browser UI |
|---|---|---|---|---|---|
| 1 | ecommerce-support | ☐ | ☐ | ☐ approve / ☐ reject | ☐ |
| 2 | hr-screening | ☐ | ☐ | n/a | ☐ |
| 3 | finance-reconciliation | ☐ | ☐ | ☐ approve / ☐ reject | ☐ |
| 4 | healthcare-intake | ☐ | ☐ | n/a (escalation flag only) | ☐ |
| 5 | legal-contract-review | ☐ | ☐ | ☐ approve / ☐ reject | ☐ |
| 6 | real-estate | ☐ | ☐ | n/a (buyer chat auto-denies) | ☐ |
| 7 | insurance-claims | ☐ | ☐ triage + record | n/a (routes via transfer_to_human) | ☐ |
| 8 | market-intel | ☐ | ☐ deep-research brief | n/a (low-coverage handover) | ☐ |
| 9 | employee-concierge | ☐ (3 containers + A2A auth) | ☐ call_peer_agent routing | n/a (prod-admin policy-denied) | ☐ |
| 10 | customer-success | ☐ | ☐ vitals readout | ☐ authorize / ☐ decline | ☐ |

Layer 1 (no containers): ☐ 12/12 configs parse · ☐ all `.py` compile · ☐ ext modules import · ☐ `open_ticket.py` runs.

Always finish with `docker compose down` in whichever project directory you're in.
