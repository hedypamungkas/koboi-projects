# Legal — First-Pass Contract Review and Redlining

> Read [`00-consuming-koboi-server.md`](00-consuming-koboi-server.md) first — this doc only covers what's different for legal.
>
> This design doc predates the build. [`../legal-contract-review/README.md`](../legal-contract-review/README.md) is the verified, tested source of truth — where the two disagree, the README wins.

An AI that reads an incoming contract, flags the clauses that don't match your playbook, and drafts a suggested fix — a lawyer reviews and sends everything, the agent never does.

## The scenario

Kessler & Vance's in-house legal team reviews a steady stream of vendor and customer contracts against a standard playbook: a list of clause types (indemnification, limitation of liability, termination, IP assignment...) with the language that's acceptable, the language that isn't, and a fallback the firm can offer instead. Today every contract gets a full manual read before anyone knows if it's routine or a problem. They want a first pass that reads the contract, compares each clause to the playbook, flags what's risky, and drafts a redline using the approved fallback text — flagging anything it doesn't recognize instead of guessing. The agent never sends, files, or signs anything. It only drafts text inside the session; a lawyer reviews it and sends it through the firm's own systems.

## What you get for free

The clause playbook — a bounded list of clause types, each with acceptable variants, unacceptable variants, and fallback language — isn't prose to search. It's closer to a set of instructions the agent should follow when it recognizes a situation, which is exactly what koboi's Skills system is for: a folder of Markdown files, one per clause type, that koboi surfaces to the model automatically based on what's being discussed. No retriever, no chunking, no embeddings — the entire playbook is content, not code. Both ways of running a turn from doc 00 work as-is: a lawyer can chat with the agent about one contract, and the same config can run as an unattended job against a queue of incoming contracts.

## What you build

One piece isn't code at all — a folder of skill files. The other is two small Python tools, wired up from your own package with no changes to koboi itself.

**A skills package for the clause playbook** — one folder per clause type, each holding a `SKILL.md` with the acceptable variants, the unacceptable ones, and the fallback text to offer instead:

```
playbook_skills/
  indemnification/SKILL.md
  limitation_of_liability/SKILL.md
  termination/SKILL.md
  ip_assignment/SKILL.md
  confidentiality/SKILL.md
```

Each `SKILL.md` is just YAML frontmatter (only `name` and `description` are required) plus a Markdown body:

```markdown
---
name: indemnification-clauses
description: Acceptable and unacceptable indemnification clause variants, with fallback language
disable-model-invocation: false
---
# Indemnification Clauses

## Acceptable variants
- Mutual indemnification, capped at total fees paid under the contract

## Unacceptable variants (propose the fallback redline below)
- Uncapped or one-sided indemnification

## Fallback language
"Each party indemnifies the other for third-party claims from its own breach or negligence, capped at fees paid in the preceding twelve months."
```

`limitation_of_liability/SKILL.md`, `termination/SKILL.md`, and the rest follow the same shape — swap in that clause type's own variants and fallback text. Every turn, koboi lists these skills (name + description) to the model and ranks them against what the lawyer or job is currently looking at; when the model decides one is relevant, koboi injects that skill's full body into context for that turn.

**Two tools** — one drafts, one escalates:

```python
# src/legal_ext/tools.py
from koboi.tools.registry import tool
from koboi.types import RiskLevel

@tool(
    name="propose_redline",
    description="Draft a suggested redline using the playbook's fallback language. Returns text only.",
    parameters={
        "type": "object",
        "properties": {
            "clause_type": {"type": "string"},
            "original_text": {"type": "string"},
            "playbook_fallback": {"type": "string"},
        },
        "required": ["clause_type", "original_text"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def propose_redline(clause_type: str, original_text: str, playbook_fallback: str = "") -> str:
    ...  # returns draft comparison text only — never writes or sends anywhere

@tool(
    name="flag_novel_clause",
    description="Flag a clause with no playbook match, for a lawyer to look at directly.",
    parameters={
        "type": "object",
        "properties": {"clause_text": {"type": "string"}, "reason": {"type": "string"}},
        "required": ["clause_text", "reason"],
    },
    risk_level=RiskLevel.SAFE,
)
async def flag_novel_clause(clause_text: str, reason: str) -> str:
    ...
```

`propose_redline` is `RiskLevel.MODERATE`, not `SAFE` — and that's deliberate, not an oversight. Over the chat transport, koboi's approval handler pauses on `MODERATE` tools the same way it pauses on `DESTRUCTIVE` ones (only `SAFE` auto-approves; doc 00 §5). So the moment the model decides a clause needs a redline, the stream emits a `pending_approval` event and waits — the lawyer sees a proposed-redline card (clause type + a one-line summary) and clicks approve or reject *before* `propose_redline` ever runs and drafts the comparison text. That's a stronger safety property than "a human reads the draft before sending it": approval gates the drafting itself, not just what happens after. `flag_novel_clause` stays `SAFE` and auto-approves, since it never proposes contract language — it only raises a flag for a lawyer to look at directly.

Jobs are the other half of this design: `/v1/jobs` runs under koboi's autonomous approval handler, which auto-approves `SAFE` and `MODERATE` tools alike (doc 00 §9) — so the overnight batch drafts redlines unattended and lands them in the lawyer's queue by morning, while the same tool, called from chat, pauses for a click first. One risk level, two correct behaviors depending on whether anyone's watching.

## Architecture

Two ways into the same koboi deployment, same skills, same tools:

```
  Lawyer's browser                     Incoming-contracts queue
  (chat, one contract                  (CLM inbox, batch,
   at a time)                           no human present)
        │  POST /v1/chat/stream               │  POST /v1/jobs
        ▼                                      ▼
  ┌───────────────────────────────────────────────────┐
  │                  koboi server (Docker)              │
  │                  config/agent.yaml                  │
  │   skill routing (playbook_skills) ──▶ propose_redline │
  │                                    ──▶ flag_novel_clause │
  └───────────────────────────────────────────────────┘
        │                                      │
        ▼                                      ▼
  Draft redline / flag shown            Risk summary lands in the
  inline in the chat, lawyer            lawyer's queue overnight,
  keeps talking through it              before they open the doc
```

Overnight, the queue runs a job per incoming contract: flag risky clauses, draft redlines, land a summary in the lawyer's queue before they open the document. During the day, a lawyer opens a flagged contract and works through it clause by clause in chat — "what's wrong with 8.2," "give me the fallback for this indemnity language." Same skills, same tools, same config; only the entry point and whether a human is watching differ.

## The frontend

A lawyer's workspace, not a chat window bolted onto a document viewer: paste or upload a contract on the left, see it side by side with the AI's flags and suggested redlines on the right, and a chat panel below for asking about any specific clause. Flagged clauses are highlighted inline; clicking one drops its text into the chat panel so the lawyer can ask follow-ups without retyping.

The clause-chat panel is doc 00 §3's `streamChat` with a couple of UI hooks added:

```js
function askAboutClause(clauseText) {
  appendUserBubble(`About this clause: "${clauseText}"`);
  streamChat(`Review this clause against the playbook: ${clauseText}`, (event) => {
    if (event.type === "text_delta") appendToBubble(event.content);       // koboi/events.py: "content", not "delta"
    if (event.type === "tool_call" && event.tool_name === "flag_novel_clause") {  // "tool_name", not "name"
      showBanner("No playbook match — flagged for review");
    }
    if (event.type === "pending_approval") {
      // propose_redline is MODERATE, so this fires before every redline draft (see above) --
      // render an approve/reject card keyed on event.approval_id and resolve it via
      // POST /v1/sessions/{id}/approve with {"approval_id", "decision": "approve"|"deny"}.
      renderApprovalCard(event);
    }
    if (event.type === "complete") enableRedlineActions();
  });
}
```

## Docker

Same one-container pattern as doc 00 §6, with the skills folder mounted as a read-only seed volume:

```yaml
services:
  koboi:
    build: ./backend
    ports: ["8000:8000"]
    volumes:
      - koboi-data:/data
      - ./playbook_skills:/app/playbook_skills:ro   # clause playbook, read-only
    env_file: .env
  web:
    build: ./frontend
    ports: ["3000:80"]
    depends_on: [koboi]
volumes:
  koboi-data:
```

The playbook is a set of Markdown files the firm edits when clause language changes — adding a clause category or updating fallback text is a file change, not a deploy.

## config/agent.yaml

```yaml
agent:
  mode: act              # not "chat" -- ModeHook blocks every custom tool by name in chat/plan
                          # regardless of risk level (doc 00 §2). The transport is still the
                          # interactive /v1/chat/stream endpoint; this is koboi's separate
                          # permission-level setting, and propose_redline/flag_novel_clause are
                          # both custom tools.

tools:
  builtin: [memory]
  custom:
    - module: legal_ext.tools

skills:
  search_paths: ["./playbook_skills"]
  budget_chars: 8000

server:
  auth_required: true
  allowed_modes: [chat, act]
  cors:
    expose_headers: ["X-Session-Id"]   # without this the browser can't read the session id back --
                                        # the review panel and the follow-up chat would silently
                                        # never share a session
  limits:
    max_iterations_cap: 15
```

`allowed_modes: [chat, act]` names the request-time `mode` values a caller may pass (doc 00 §2's transport-level knob); `agent.mode: act` above is the config's own default permission level, and it's what actually lets `propose_redline`/`flag_novel_clause` run at all. `plan`, `auto`, and `yolo` add nothing here, so they're left out of `allowed_modes`. Escalation needs no extra config either: `flag_novel_clause` covers a clause with no playbook match at all, and each skill's own "escalate, do not draft" section covers a clause that matches a known type but shouldn't get an automatic redline.

## Why it matters

The built-in path — chat, jobs, streaming, memory — needed no changes to handle a completely different kind of lookup: a structured playbook instead of prose documents. The only Python is two small tools; the entire clause playbook is Markdown, and koboi's own skill routing figures out which clause type applies. The safety property that matters most here — nothing ever leaves the session without a lawyer seeing it first — falls out of picking the right risk level for the tools, not from writing extra plumbing. Same codebase, same server, a different business on top.

## Open questions

- **Playbook size and `budget_chars`.** A few dozen short clause skills comfortably fit under the discovery list and the 8,000-character per-activation budget. If the playbook grows much larger, or fallback language gets long, `budget_chars` may need raising, or the largest clause types may need splitting into narrower skills.
- **Where novel-clause flags go.** `flag_novel_clause` puts a flag in the current turn or job output, but doc 00 has no notification or webhook mechanism — jobs are pulled, not pushed. Does the firm's queue system poll for flags, or does this need a small custom hook to push a notification somewhere?
- **How long contract text should stay in session memory.** Contract text sits in koboi's session storage for the life of the session. Does legal need a shorter retention window or encryption beyond what the `/data` volume already provides?
- **`allowed-tools`/`disallowed-tools` aren't enforced.** A skill's frontmatter can list these fields, but koboi doesn't currently check them anywhere in the tool-calling pipeline — they document intent to the model, they don't restrict what a skill can actually trigger, so they're not a substitute for keeping `propose_redline` at `MODERATE`.
