# Sector One-Pager: Healthcare — Pre-Visit Patient Intake & Triage Assistant

> **Status:** Design draft · **Date:** 2026-07-03
> **Depends on:** [`00-consuming-koboi-server.md`](./00-consuming-koboi-server.md) — read that first for endpoints,
> auth, chat-vs-job modes, SSE event shape, and extension points. This doc only covers what's specific to
> pre-visit patient intake.

---

## 1. Context & assumptions

A clinic wants a chatbot patients interact with **before** their visit: it asks structured symptom/history
questions, cross-checks answers against clinical protocol/formulary documents for red-flag criteria (e.g.
"chest pain + shortness of breath → escalate to urgent care now"), and hands the clinician a structured
summary. It never diagnoses and never touches the EHR directly.

Assumptions this design bakes in:

- **Interactive chat only, `mode: chat` (or `plan` for internal staff review runs) — never `act`.** This is a
  live conversation with a patient, not a batch/autonomous workflow. Per doc 00 §1, `act` mode implies
  tool-driven autonomy; intake has no business calling `act`-style tool chains against a patient in the loop.
  `server.allowed_modes` for this deployment should be restricted to `chat,plan` (see §4 config).
- **The RAG corpus is clinical protocol/formulary documents** — triage criteria, red-flag symptom lists,
  medication formulary notes — supplied and version-controlled by the clinic's clinical staff, not by
  engineering. This is reference material for grounding, not a source of instructions to act on.
- **No EHR write path exists in this system, by design.** The agent produces a structured summary that a
  human clinician reviews and manually (or via a separate, clinic-owned EHR integration) files. Koboi itself
  never gets EHR credentials or an EHR-writing tool.
- **PII/PHI must never reach logs or the Langfuse trace in raw form.** Patient name, DOB, phone, insurance ID,
  and free-text symptom descriptions are all potentially PHI. Anything that leaves the request/response path
  and lands in a persistence or observability sink must be redacted first.
- This is a **regulated context**. Koboi-agent itself makes no HIPAA claims (see §8) — compliance is entirely
  this project's responsibility, achieved through config choices (tracing off/scoped), guardrail design
  (redaction), and infra controls (encryption at rest, access control) layered on top of the generic contract.

## 2. Architecture

```
                    ┌────────────────────┐
                    │ Patient chat widget │  (web/mobile, pre-visit)
                    └──────────┬─────────┘
                               │ POST /v1/chat/stream  { message, mode: "chat" }
                               ▼
                    ┌────────────────────────────┐
                    │        koboi server         │
                    │                              │
   PRE_INPUT hook ─▶│  1. PHI/PII redact-or-block  │  (before LLM ever sees raw input,
   (redaction        │     guardrail (input side)  │   AND before anything is logged)
    guardrail)       │                              │
                    │  2. RAG retrieve over         │
                    │     clinical protocol /       │──▶ [protocol docs, formulary,
                    │     formulary corpus           │     red-flag criteria — versioned
                    │                              │     by clinical staff]
                    │  3. LLM turn (grounded on      │
                    │     retrieved protocol text)   │
                    │                              │
                    │  4. flag_urgent_escalation     │  SAFE tool — sets a flag +
                    │     tool (if red-flag pattern  │  writes to review queue table;
                    │     matched)                    │  does NOT contact EHR/911/staff
                    │                              │  directly, just raises a flag
                    │                              │
   POST_OUTPUT /     │  5. Output guardrail: strip    │
   output guardrail ─▶│     any PHI before response   │──▶ Langfuse trace (if enabled) —
    (redaction)       │     is traced/logged           │     sees redacted text only
                    └──────────┬───────────────────┘
                               │ SSE stream (text_delta, tool_call,
                               │ tool_result, complete, ...)
                               ▼
                    ┌────────────────────┐
                    │ Patient chat widget │  (sees full, non-redacted answer —
                    └────────────────────┘   redaction is a logging/tracing-side
                                              concern, not a patient-facing one)

                    ┌──────────────────────────────┐
   structured        │  Clinician review queue        │
   intake summary ──▶│  (separate app/table — NOT     │──▶ human reviews, decides,
   (end of session)  │  koboi; koboi just produces     │    files to EHR themselves
                    │  the summary text/JSON)         │
                    └──────────────────────────────┘
```

Key point: redaction happens on the **logging/tracing path**, not the patient-facing response path — the
patient needs to see their own answers reflected back normally; it's what koboi persists/traces that must be
scrubbed. The `flag_urgent_escalation` tool and the redaction guardrail are the two sector-specific pieces;
everything else (SSE transport, session lifecycle, auth) is generic per doc 00.

## 3. Project structure

```
healthcare-intake/
├── pyproject.toml                  # depends on koboi-agent[api]; registers the
│                                    # koboi.guardrails entry point (see §4b)
├── config/
│   └── agent.yaml                  # mode: chat, rag:, guardrails.output, tracing (scoped/off)
├── src/
│   └── healthcare_ext/
│       ├── __init__.py
│       ├── tools.py                 # flag_urgent_escalation (SAFE)
│       └── guardrails.py            # PHIRedactionGuardrail(PatternGuardrail)
├── data/
│   └── seed/                        # clinical protocol/formulary docs (RAG corpus)
│       ├── red_flag_criteria.md
│       └── formulary_notes.md
└── Dockerfile                       # FROM koboi base image pattern per doc 00 §6
```

## 4. Key code skeletons

### 4a. `flag_urgent_escalation` tool (SAFE)

Raises a flag for staff; it never contacts emergency services, the EHR, or a human directly — it only writes
a row a human-facing review queue polls. Deliberately `RiskLevel.SAFE` and side-effect-minimal: no filesystem,
no shell, no network call to an external paging system baked into the tool itself (that integration, if
wanted, belongs in a `POST_TOOL_USE` hook that watches for this tool's calls — see doc 00 §5 table).

```python
# src/healthcare_ext/tools.py
"""healthcare_ext/tools.py -- intake-specific tools (deliberately write-light)."""

from koboi.tools.registry import tool
from koboi.types import RiskLevel


@tool(
    name="flag_urgent_escalation",
    description=(
        "Flag the current intake session for urgent clinical review. Use ONLY when the "
        "patient's answers match a red-flag criterion from the clinical protocol corpus "
        "(e.g. chest pain + shortness of breath). Does not diagnose, does not contact "
        "emergency services, and does not write to the EHR -- it only queues the session "
        "for a human clinician to review immediately."
    ),
    parameters={
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "description": "The red-flag criterion matched, quoting the protocol text.",
            },
            "urgency": {
                "type": "string",
                "enum": ["urgent_care_now", "same_day", "routine_flag"],
            },
        },
        "required": ["reason", "urgency"],
    },
    risk_level=RiskLevel.SAFE,
)
async def flag_urgent_escalation(reason: str, urgency: str, _deps: dict) -> str:
    """Write a flag row to the clinician review queue. Never touches the EHR."""
    review_queue = _deps["review_queue"]  # injected dependency, clinic-owned store
    await review_queue.enqueue(reason=reason, urgency=urgency)
    return f"Escalation flagged ({urgency}); a clinician will review this session."
```

Register in `config/agent.yaml` under `tools.custom` (see §4c). No other write-capable tool is registered in
this sector's config — see §5.

### 4b. PHI redaction guardrail

Per doc 00 §5, guardrails have no YAML `custom_modules` key — register via the `koboi.guardrails` entry-point
group in `pyproject.toml`. Subclasses `PatternGuardrail` (regex-driven; override `PATTERNS`/`DEFAULT_ACTION`
or pass `custom_patterns` — per doc 00's extension-point table) to catch phone numbers, DOB, and insurance IDs
before they reach logs or the Langfuse trace.

```python
# src/healthcare_ext/guardrails.py
"""healthcare_ext/guardrails.py -- redacts PHI from anything that gets logged/traced."""

import re

from koboi.guardrails.base import PatternGuardrail  # exact base per doc 00 extension table


class PHIRedactionGuardrail(PatternGuardrail):
    """Redacts phone numbers, DOB-shaped dates, and insurance IDs.

    NOTE: pattern coverage here is illustrative, not exhaustive -- see open question
    in Sec. 8 about validating this against a proper PHI de-identification standard
    (e.g. HIPAA Safe Harbor's 18 identifiers) before production use.
    """

    PATTERNS = {
        "phone": re.compile(r"\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b"),
        "dob": re.compile(r"\b(0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])[/-](19|20)\d{2}\b"),
        "insurance_id": re.compile(r"\b[A-Z]{2,4}-?\d{6,10}\b"),
    }
    DEFAULT_ACTION = "redact"  # replace match with "[REDACTED:<label>]", not block-the-turn


def register(registry) -> None:
    """Entry-point callable invoked by koboi's GuardrailRegistry."""
    registry.register("phi_redaction", lambda **cfg: PHIRedactionGuardrail(**cfg))
```

```toml
# pyproject.toml (excerpt)
[project.entry-points."koboi.guardrails"]
phi_redaction = "healthcare_ext.guardrails:register"
```

This guardrail is wired as an **output** guardrail (`guardrails.output` in YAML) so it scrubs what's about to
be persisted/traced. Whether it should *also* run as a `PRE_INPUT` guardrail on the raw patient message (per
doc 00's `PRE_INPUT` hook event) so PHI never enters the LLM prompt context at all — vs. only scrubbing what
leaves the system — is a real design decision; see open question in §8.

### 4c. `config/agent.yaml`

```yaml
mode: chat                    # chat only for this deployment; plan allowed for internal
                               # staff test runs, act/yolo excluded via allowed_modes below

server:
  allowed_modes: [chat, plan]  # act/auto/yolo rejected with 400 invalid_mode (doc 00 §1)

rag:
  retriever: hybrid            # keyword+semantic over the protocol/formulary corpus
  corpus_path: ./data/seed
  top_k: 8

tools:
  custom:
    - module: healthcare_ext.tools   # registers flag_urgent_escalation only
  # No filesystem/shell/git/subagent tools enabled -- see Sec. 5.

guardrails:
  output:
    - phi_redaction            # registered via koboi.guardrails entry point (Sec 4b)

# --- Decision point: tracing ---
# Langfuse tracing (doc 00 Sec 6) captures conversation content for observability.
# Even with the output guardrail scrubbing structured PHI patterns, free-text patient
# answers ("I've had a headache since my daughter's birthday, March 3rd...") can carry
# PHI the regex patterns don't catch. Two acceptable postures, pick one explicitly:
#   (a) tracing disabled entirely (omit `tracing:` block / leave LANGFUSE_* unset --
#       doc 00 confirms this fails open/no-op) -- safest default for this sector.
#   (b) tracing enabled but scoped: trace metadata only (latencies, tool calls, token
#       counts), never `content` fields -- requires verifying koboi's Langfuse
#       integration supports content-exclusion (see open question, Sec 8).
# This config ships with tracing OFF (option a) as the default-safe posture.
# tracing:
#   provider: langfuse   # <- intentionally left commented out
```

## 5. Safety design

- **The agent never diagnoses.** This is enforced at the prompt/scope level (system prompt explicitly
  instructs "ask structured questions, surface protocol-grounded information, never state or imply a
  diagnosis") — it is not something koboi's tool/guardrail machinery can mechanically guarantee. Treat this as
  a prompt-engineering and eval-suite responsibility (regression-test the system prompt against
  diagnosis-seeking phrasing).
- **The agent never writes to the EHR.** There is no EHR-writing tool in this sector's tool registry, full
  stop — not a permission gate, an absence. `tools.custom` in §4c registers exactly one tool
  (`flag_urgent_escalation`), and no builtin `DESTRUCTIVE`-risk tools (`shell`, `filesystem` write, `git`) are
  enabled. This is deliberate: the safety property here is "the model cannot act," not "the model's actions
  are approved," because approval workflows (HITL per doc 00 §1) still assume the tool *could* do something
  consequential if approved. In this sector, the intake agent should have **no path** to anything
  consequential — everything funnels to a human-owned review queue that koboi itself never writes into
  downstream systems from.
- **Structured summary hand-off is data, not action.** The end-of-session summary the clinician sees is
  produced as response content (or via a narrow, review-queue-only write inside `flag_urgent_escalation` and
  a parallel end-of-session summary tool if one is added later) — never an API call to an EHR, pharmacy, or
  scheduling system.

## 6. Deployment

Single-node self-host per doc 00 §6 — no changes to the generic deployment shape. One addition specific to
this sector:

- The `/data` volume (per doc 00 §6: `koboi_memory.db` + WAL files, `keys.json`, per-session sandbox workdirs)
  will contain **conversation history that is itself PHI** for this deployment — patient symptom descriptions,
  session transcripts, potentially the un-redacted turn history (redaction per §4b is scoped to the
  logging/tracing path, not necessarily to what `ConversationMemory`/SQLite persists across turns — see open
  question in §8). Ops must treat the entire `koboi-data` volume as PHI storage: encryption at rest, restricted
  access control, and inclusion in the clinic's existing HIPAA technical-safeguards program. **Koboi does not
  encrypt this volume itself or enforce access control on it — that is entirely the deploying customer's
  responsibility**, same as any other self-hosted SQLite-backed service.
- Session TTL / sandbox workdir GC (default 24h per doc 00 §6) should be reviewed against the clinic's PHI
  retention policy — 24h may be too long or too short depending on the clinic's data retention requirements.

## 7. What this demonstrates

This sector highlights koboi's **RAG pipeline grounding responses in a versioned clinical-protocol corpus**
(so red-flag detection is document-driven, not model-improvised), a **custom output guardrail built on the
`PatternGuardrail` extension point** for domain-specific redaction (PHI, here; the same pattern generalizes to
PII in other regulated sectors), and a **deliberately tool-light design** where the safety guarantee comes
from what capabilities are *absent* from the tool registry rather than from approval gating on present ones.

## 8. Open questions

- **HIPAA/BAA coverage for the chosen LLM provider.** Doc 00 covers OpenAI/Anthropic/Cloudflare as koboi's
  supported providers but makes no compliance claims about any of them. Before implementation, the customer
  must confirm which provider they'll use has a signable BAA and confirm koboi's HTTP client (`client.py`)
  doesn't log/cache request bodies anywhere that would violate that BAA's terms. Koboi itself provides no
  HIPAA guarantee — this is entirely a provider-selection and contractual decision for the customer.
- **Does `ConversationMemory`/SQLite persistence store raw (un-redacted) turn content, or only the
  guardrail-redacted version?** Doc 00 doesn't specify whether output guardrails run before or after a turn
  is written to conversation memory (vs. only scrubbing what reaches logs/Langfuse). If raw PHI lands in
  `koboi_memory.db` regardless of the output guardrail, the "protect the `/data` volume" mitigation in §6
  becomes load-bearing rather than defense-in-depth — worth confirming against the actual `memory_sqlite.py`
  write path before committing to a redaction strategy.
- **Should PHI redaction run at `PRE_INPUT` (before the LLM ever sees raw patient text) in addition to
  `POST_OUTPUT`/logging-side redaction?** The former protects against the LLM provider itself retaining
  prompt content; the latter only protects koboi's own logs/traces. These are different threat models and the
  customer should decide which (or both) they need, informed by the BAA question above.
- **What does "urgent escalation" actually notify?** `flag_urgent_escalation` (§4a) only enqueues a row to a
  review queue — it assumes clinical staff are actively polling that queue during clinic hours. For a
  same-day urgent-care scenario, is passive queue-polling sufficient, or does the clinic need a paging/SMS
  integration on top (built as a `POST_TOOL_USE` hook watching for this tool per doc 00 §5, out of scope for
  koboi itself)?
- **Retention/deletion policy for patient conversations.** Given `/data` holds PHI (§6), what's the clinic's
  required retention window, and does anything need to actively purge sessions after that window — koboi's
  session TTL/GC (default 24h, doc 00 §6) is about sandbox workdir cleanup, not a compliance-grade retention
  control, and shouldn't be assumed to satisfy one.
