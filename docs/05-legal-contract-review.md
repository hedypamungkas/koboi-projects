# Legal — First-Pass Contract Review & Redlining

> **Status:** Design one-pager (not yet built) · **Date:** 2026-07-03
> **Reference:** [`docs/00-consuming-koboi-server.md`](00-consuming-koboi-server.md) — read first for endpoints,
> auth, chat-vs-job modes, SSE shape, and extension points. This doc only covers what's specific to this sector.

## Business problem

An in-house legal team reviews a high volume of vendor/customer contracts against a standard clause playbook
(acceptable/unacceptable clause variants, fallback language) and wants an AI first-pass that flags risky
clauses, suggests redlines from the playbook, and routes anything novel to a human lawyer. The hard constraint:
**the agent never sends a redline externally** — it only drafts suggestions inside the session for a lawyer to
review, edit, and send through the firm's own systems.

## 1. Context & assumptions

| | |
|---|---|
| Customer | In-house legal team or outside counsel doing first-pass review on vendor/customer paper |
| What's dynamic (per-contract) | The contract text itself — pasted or uploaded per turn/job, never persisted as playbook knowledge |
| What's static (RAG corpus) | The clause playbook: acceptable/unacceptable variants per clause type (indemnity, limitation of liability, termination, IP assignment, ...) + fallback language for each |
| Execution mode | **Both**, and this is a deliberate recommendation (see below) |
| `mode` | `chat` for interactive review, `act` for batch first-pass jobs — `plan`/`auto`/`yolo` add no value here and are excluded from `allowed_modes` |
| Session lifetime | Chat: one session per contract, spans the lawyer's whole review sitting. Jobs: one job per contract in the incoming queue, no session persists after |

**Why both chat and jobs, not just one** — same dual-mode reasoning as the finance sector doc
(`03-finance-invoice-reconciliation.md`) applied to reconciliation:

- **Batch triage** (`POST /v1/jobs`) — an incoming-contracts queue (CLM system or shared inbox) gets a
  first-pass job per document overnight: flag clauses that deviate from the playbook, attach a risk summary,
  land it in the lawyer's queue before they open the doc. No human is present, so per doc 00 §1 (jobs have no
  HITL support) nothing here writes or sends anything — `propose_redline` only drafts into the job's own output.
- **Interactive drafting** (`POST /v1/chat/stream`) — once a lawyer opens a flagged contract, they work through
  it clause-by-clause: "what's wrong with clause 8.2", "give me the fallback for this indemnity language."
  Real-time back-and-forth, not a one-shot report.

Both modes hit the same `propose_redline` tool and the same clause-playbook retriever; only the entry point and
presence of a human differ.

## 2. Architecture

```
                    ┌────────────────────┐        ┌──────────────────────┐
                    │  Lawyer (chat UI)   │        │ Incoming-contracts    │
                    │  pastes/uploads     │        │ queue / CLM webhook    │
                    │  contract text      │        │ (batch, no human)      │
                    └─────────┬──────────┘        └──────────┬────────────┘
                              │ POST /v1/chat/stream           │ POST /v1/jobs
                              ▼                                ▼
                       ┌────────────────────────────────────────────┐
                       │            koboi server (1 node)             │
                       │            config/agent.yaml                 │
                       └───────────────────┬──────────────────────────┘
                                            │
                 ┌──────────────────────────┼──────────────────────────┐
                 ▼                          ▼                          ▼
      ┌────────────────────┐   ┌─────────────────────┐    ┌────────────────────────┐
      │ clause_playbook      │   │ PolicyEngine          │    │ legal_ext.tools         │
      │ retriever (custom or │   │ (policy.rules[] +     │    │  - propose_redline      │
      │ koboi builtin RAG —  │──▶│  hardcoded safety)     │───▶│    (RiskLevel.MODERATE) │
      │ open Q, see §8)       │   │ runs PRE_TOOL_USE      │    │  - flag_novel_clause    │
      └────────────────────┘   │ priority 25            │    │    (RiskLevel.SAFE)     │
                                 └──────────┬─────────────┘    └───────────┬────────────┘
                                            │ deny → abort,                │
                                            │ confirm → flagged            │
                                            │ in metadata                  ▼
                                            │                    Draft redline / risk
                                            │                    summary returned in the
                                            │                    turn or job output —
                                            │                    NOTHING sent externally
                                            ▼
                                 Human lawyer reviews and
                                 finalizes outside koboi
                                 (their own doc/email tooling)
```

- The clause-playbook retriever surfaces the relevant playbook entries (acceptable variants + fallback
  language) for whatever clause the lawyer/job is looking at — same RAG augmentation flow doc 00 describes.
- `PolicyEngine` (see §5) runs before *every* tool call, including `propose_redline`. A hard-block rule can
  force certain clause categories to `deny` (with `ctx.inject_message` telling the agent it must escalate
  instead of drafting) rather than ever reaching the drafting step.
- `propose_redline` only ever returns text into the current turn/job output. There is no send-email,
  CLM-write, or e-signature tool in this design — nothing DESTRUCTIVE exists in this sector's tool surface.

## 3. Project structure

```
legal-contract-review/
├── pyproject.toml
├── config/
│   └── agent.yaml
├── src/
│   └── legal_ext/
│       ├── __init__.py
│       ├── rag/
│       │   ├── __init__.py
│       │   └── clause_retriever.py   # @register_retriever("clause_playbook")
│       └── tools.py                   # propose_redline, flag_novel_clause
├── data/
│   └── seed/                          # clause_playbook.jsonl or one .md per clause type
├── Dockerfile
└── tests/
    └── test_tools.py
```

`pyproject.toml` declares `koboi-agent[api] @ git+https://.../koboi-agent.git` and installs `legal_ext` as an
editable package, exactly per doc 00 §5/§6.

## 4. Key code skeletons

### (a) Custom retriever over the clause playbook

Mirrors doc 00 §5's constructor-introspection contract — YAML keys under `rag:` match `__init__` params by name.

```python
# src/legal_ext/rag/clause_retriever.py
from koboi.rag.registry import register_retriever
from koboi.rag.retriever import BaseRetriever
from koboi.rag.types import RetrievalResult


@register_retriever("clause_playbook", description="Structured clause library: variants + fallback language")
class ClausePlaybookRetriever(BaseRetriever):
    def __init__(self, playbook_path: str, clause_taxonomy: list[str] | None = None):
        # playbook_path: firm's structured clause library (JSON/YAML/DB-backed — see open question in §8
        # on whether this stays file-based or moves to a dedicated vector store)
        self._playbook_path = playbook_path
        self._taxonomy = clause_taxonomy or []
        self._entries = self._load(playbook_path)

    def _load(self, path: str) -> list[dict]:
        # parse the clause library into {clause_type, acceptable_variants, unacceptable_variants, fallback}
        ...

    async def retrieve(self, query: str, top_k: int = 3) -> list[RetrievalResult]:
        # match the contract clause text (query) against clause_type entries — keyword match on the
        # taxonomy is likely sufficient given a bounded clause vocabulary; swap for embedding similarity
        # if the playbook grows past what keyword matching handles well
        ...
```

### (b) `propose_redline` tool — drafts only, sends nothing

```python
# src/legal_ext/tools.py
from koboi.tools.registry import tool
from koboi.types import RiskLevel

@tool(
    name="propose_redline",
    description=(
        "Draft a suggested redline for a contract clause, using the firm's clause playbook fallback "
        "language. Returns draft text only — never sends or applies anything externally."
    ),
    parameters={
        "type": "object",
        "properties": {
            "clause_type": {"type": "string", "description": "e.g. indemnification, limitation_of_liability"},
            "original_text": {"type": "string", "description": "The clause as written in the contract"},
            "playbook_fallback": {"type": "string", "description": "Fallback language retrieved from the playbook"},
        },
        "required": ["clause_type", "original_text"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def propose_redline(clause_type: str, original_text: str, playbook_fallback: str = "") -> str:
    # returns a draft comparison + suggested redline as text; does not write to any external system
    ...

@tool(
    name="flag_novel_clause",
    description="Flag a clause that has no playbook match for human review — does not attempt to redline it.",
    parameters={
        "type": "object",
        "properties": {
            "clause_text": {"type": "string"},
            "reason": {"type": "string", "description": "Why this doesn't match a known playbook pattern"},
        },
        "required": ["clause_text", "reason"],
    },
    risk_level=RiskLevel.SAFE,
)
async def flag_novel_clause(clause_text: str, reason: str) -> str:
    ...
```

### (c) `config/agent.yaml` (relevant excerpts)

```yaml
tools:
  builtin: [memory]
  custom:
    - module: legal_ext.tools

rag:
  retriever: clause_playbook
  custom_modules:
    - legal_ext.rag.clause_retriever
  playbook_path: data/seed/clause_playbook.jsonl
  clause_taxonomy: [indemnification, limitation_of_liability, termination, ip_assignment, confidentiality]
  top_k: 5

policy:
  rules:
    - tool: propose_redline
      pattern: "uncapped liability"
      action: deny
    - tool: propose_redline
      pattern: "unlimited indemnification"
      action: deny

server:
  auth_required: true
  allowed_modes: [chat, act]
  limits:
    max_iterations_cap: 15
```

`tools.custom` and `rag.retriever`/`rag.custom_modules` follow doc 00 §5's registration contract exactly — no
koboi core code is touched. The `policy.rules` block is real, code-verified `koboi` config (`PolicyRuleConfig`
in `config_models.py`, consumed by `PolicyEngine` at `PRE_TOOL_USE`, priority 25) — **but see the important
caveat in §5 before relying on the `pattern` field for clause text.**

## 5. Escalation design

Two independent layers combine so nothing legally binding is ever auto-generated without a lawyer's eyes:

1. **`policy.rules` hard blocks (upstream, pattern-based, non-negotiable).** koboi's `PolicyEngine` runs at
   `PRE_TOOL_USE` (priority 25, before the tool executes), evaluating every call against configured rules
   first-match-wins, *in addition to* koboi's hardcoded sensitive-path/command-deny checks that always run
   first and can't be overridden. A `deny` action sets `ctx.abort = True` — the tool never runs, and
   `ctx.inject_message` tells the agent why, so it must escalate to the lawyer instead of drafting anything.
2. **`RiskLevel.MODERATE` on `propose_redline` (downstream, per-call).** Even for clauses that pass the policy
   layer, `propose_redline` only ever *drafts* — no side effect on any external system. `MODERATE` sits below
   koboi's `DESTRUCTIVE` approval-gate threshold (doc 00 §5), which is correct here: there's nothing to approve
   because nothing is being sent or applied. The real "approval" step is the lawyer reading the drafted redline
   before using it — human-in-the-loop by workflow, not a koboi `pending_approval` handshake.

**Contrast with finance:** `03-finance-invoice-reconciliation.md` uses `RiskLevel.DESTRUCTIVE` + a
maker-checker `ApprovalHandler` because its tool *writes to a system of record* (posts a journal entry). Legal
never writes or sends anything externally, so there's no write-side action to gate — the risk is entirely in
*content*, which is why the gate sits upstream in retrieval/policy rather than on an approval step downstream
of a write.

**Caveat on `policy.rules`, verified against `koboi/facade.py::_build_policy`:** the YAML→engine wiring always
maps a rule's `pattern` to an argument literally named `command` (`argument_patterns={"command": pattern}`),
and `PolicyEngine._match_rule` requires that literal substring to appear in the tool's serialized arguments
before it attempts a match — built with shell-command denial in mind (`run_shell`, `git_*`). `propose_redline`'s
arguments (`clause_type`/`original_text`/`playbook_fallback`) have no `command` key, so a rule as sketched in
§4(c) **will not match** unless the pattern also appears as a raw substring in the serialized argument blob
(the code's fallback path). Doc 00 doesn't cover this field-level semantic — see the open question below rather
than assuming it "just works."

## 6. Deployment

Single self-hosted node, per doc 00 §6: `pip install "koboi-agent[api] @ git+..."`, `koboi serve
config/agent.yaml --host 0.0.0.0 --port 8000`, `/data` volume for `koboi_memory.db*` + `keys.json` + session
workdirs. No sector-specific deployment wrinkles.

## 7. What this demonstrates

This sector is the clearest illustration of koboi's **custom retriever over a structured (non-document)
knowledge base** — the clause playbook isn't prose to chunk, it's a taxonomy of variants and fallback language,
which is exactly what the constructor-introspection registration pattern (doc 00 §5) is designed to make easy
to swap in. It also exercises the `policy.rules` engine as a content-level hard-block distinct from koboi's
risk-level/approval machinery, and shows the dual chat+job pattern applied to a workflow where batch triage and
interactive drafting are both genuinely necessary, not just "nice to support."

## 8. Open questions

- **Playbook storage: file-based RAG vs. dedicated vector DB?** Doc 00 doesn't prescribe a default vector store
  and koboi's built-in RAG is file-corpus-oriented. A bounded, well-structured clause taxonomy (dozens of
  clause types, each with a handful of variants) may not need embeddings at all — keyword/taxonomy matching in
  the custom retriever sketched in §4(a) might suffice. Needs a decision once the real playbook size and update
  cadence (how often does legal add fallback language?) are known.
- **`policy.rules` pattern-matching precision.** Per the §5 caveat, the current YAML wiring only reliably
  matches an argument named `command`. Before relying on `policy.rules` for clause-text hard blocks, this needs
  either (a) a workaround — e.g. having `propose_redline` also accept/log its input under a `command`-named
  field purely so the pattern check fires, which is hacky — or (b) constructing `PolicyEngine`/`PolicyRule`
  objects programmatically (bypassing YAML) inside `legal_ext`, or (c) a small upstream change to koboi's
  `_build_policy` to take an argument-name field. This is a real gap, not something doc 00 resolves.
  **Do not build the hard-block feature on the YAML `policy.rules` path as sketched in §4(c) without resolving
  this first.**
- **Novel-clause escalation UX.** `flag_novel_clause` writes a flag into the current turn/job output — but who
  actually gets notified for chat-mode escalations vs. batch-job flags? Doc 00 has no notification/webhook
  primitive (jobs are pull-only per §7); does the firm's CLM or ticketing system need to poll job output, or is
  a custom `POST_TOOL_USE` hook (doc 00 §5) needed to push a notification elsewhere?
- **Confidentiality of contract text in `koboi_memory.db`.** Contract text and playbook comparisons will sit in
  SQLite-backed session memory (doc 00 §6) for the session's lifetime. Does the firm need encryption-at-rest
  beyond what the `/data` volume provides, or a stricter session TTL/purge policy than the default sandbox
  workdir GC (24h)?
- **Fallback-language authority.** If `propose_redline` suggests fallback language and the lawyer accepts it
  verbatim, is that treated as pre-approved by whoever owns the playbook, or does every redline — regardless of
  how closely it matches an existing fallback — need a second sign-off? This is a firm policy decision, not a
  technical one, but it affects whether any future write-side tool (e.g. pushing an accepted redline back into
  a CLM system) would need `DESTRUCTIVE` + approval like finance's pattern, or could stay `MODERATE`.
