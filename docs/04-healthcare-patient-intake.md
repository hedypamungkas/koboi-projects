# Riverside Family Clinic: Pre-Visit Patient Intake

A chat that asks patients about their symptoms before the visit, checks their answers against the clinic's
own protocol documents for anything urgent, and hands the doctor a clean summary — it never diagnoses and
never touches the patient record.

> Reads on top of [`00-consuming-koboi-server.md`](./00-consuming-koboi-server.md). This doc only covers
> what's specific to intake.

## The scenario

Riverside Family Clinic runs four locations and wants patients to fill out their symptom history online
before they arrive, instead of on a clipboard in the waiting room. A pre-visit chat asks structured
questions — what's wrong, since when, any other conditions — and checks the answers against the clinic's
triage protocol (a set of documents written and maintained by Riverside's own clinical staff) for red-flag
combinations like chest pain plus shortness of breath. If something looks urgent, it flags the session for
a nurse to look at right away. Otherwise, the doctor just sees a clean summary before the patient sits down.
The chat never guesses at a diagnosis, and it never writes anything into Riverside's patient record system.

## What you get for free

koboi's RAG engine and chat mode are built in. Point `rag.corpus_path` at Riverside's protocol documents,
set `mode: chat`, and patients already get an answer grounded in the clinic's own triage rules instead of
whatever the model happens to know about medicine. No retrieval code, no chat loop, no session handling to
write.

That means almost none of the engineering here is "build a chatbot." The real work is the safety layer on
top: making sure the agent can raise a flag but can never act on it, and making sure nothing sensitive a
patient types leaks into a log file.

Also built in: an output guardrail (`guardrails.output: {detect_sensitive: true}`) that catches API keys,
passwords, and card numbers in the model's reply — pure YAML, no code. It stops there, though: phone
numbers, dates of birth, and insurance IDs aren't secrets in the pattern-matching sense, so this filter
doesn't touch them. koboi's built-in filter catches secrets, not PHI — that's the custom guardrail's job,
below.

## What you build

Two small pieces, both plain extensions per doc 00 §5 — no changes to koboi itself.

| Piece | What it does | Wired up as |
|---|---|---|
| `flag_urgent_escalation` tool | Marks a session for a nurse to review now. Nothing else. | A `tool`, `SAFE` risk level, registered via `tools.custom` |
| `PHIRedactionGuardrail` | Strips phone numbers, dates of birth, and insurance IDs before anything is logged or traced | A custom guardrail, subclass of `PatternGuardrail`, registered via a `koboi.guardrails` Python entry point (doc 00 §5) |

The important design choice: **this deployment has no tool that can write anywhere consequential.** There's
no EHR tool, no filesystem write, no shell, no `git`. `flag_urgent_escalation` only adds a row to a review
queue a human is already watching — it can't page anyone, can't write a chart, can't do anything on its own.
Doc 00 explains that `DESTRUCTIVE` tools pause for human approval — this design skips that whole question by
simply not giving the agent anything destructive to begin with. Safety here comes from what the agent
*can't* do, not from a gate on what it can.

### Don't lose the first message

Patients usually name their main symptom in the very first message, then spend the rest of the conversation
answering follow-up questions. koboi's default context handling trims the oldest messages first once a
conversation outgrows the context window — exactly the message this app can't afford to lose. Setting
`context.strategy: smart_truncation` fixes that: it always keeps the system prompt and the literal first
user message verbatim, plus the most recent `keep_last` messages.

The honest limit: it only guarantees the *first* message. A detail a patient adds in message 8 of a
30-message conversation is just as exposed to trimming past `keep_last` as under the default strategy —
this isn't "remember everything that matters," it's "don't lose whatever came first."

## Architecture

```
  Patient's phone/laptop           koboi (Docker)                    Clinic side
  ┌──────────────────┐   SSE      ┌──────────────────────┐
  │  Intake chat      │──────────▶│  RAG over Riverside's │
  │  (pre-visit)      │           │  protocol documents   │
  └──────────────────┘           │                        │
                                  │  flag_urgent_escalation│───▶ Clinician review queue
                                  │  (SAFE, flag only)     │     (nurse checks this — not koboi,
                                  │                        │      not the EHR)
                                  │  output guardrail:     │
                                  │  redact PHI before     │───▶ logs / traces (redacted only)
                                  │  it's logged           │
                                  └──────────────────────┘
```

The patient always sees their own words reflected back normally — redaction only affects what koboi writes
to logs or a trace, never the conversation itself.

## The frontend

Two small views, both plain web pages talking to koboi over the same `/v1/chat/stream` endpoint from doc 00:

- **Patient intake chat.** Mobile-friendly, short questions, plain language. The header says outright:
  *"This won't diagnose you — it's here to collect your symptoms before your visit."* No medical jargon in
  the UI copy, no green-checkmark reassurance styling that could read as a clean bill of health.
- **Clinician summary view.** An internal page a nurse or doctor opens before the appointment: the intake
  conversation, plus a red banner if `flag_urgent_escalation` fired, plus the urgency level. This is a plain
  read view — it doesn't call koboi at all, it just reads whatever `flag_urgent_escalation` wrote to the
  review queue.

The patient chat widget is doc 00 §3's `streamChat` with nothing added beyond rendering the text:

```js
streamChat(userMessage, (event) => {
  if (event.type === "text_delta") {
    bubble.textContent += event.text;
  } else if (event.type === "complete") {
    bubble.classList.add("done");
  }
});
```

No custom event handling needed — `flag_urgent_escalation` runs silently in the background; the patient
never sees a "you've been flagged" message, since that's for the clinician's screen, not theirs.

## Docker

Same shape as doc 00 §6, with the protocol corpus mounted in:

```yaml
services:
  koboi:
    build: ./backend                    # koboi-agent[api] + healthcare_ext, pip install -e .
    ports: ["8000:8000"]
    volumes:
      - koboi-data:/data                # memory db, keys, sessions -- see PHI note below
      - ./data/protocols:/app/data/seed:ro   # Riverside's triage documents, read-only
    env_file: .env
  web:
    build: ./frontend                   # patient chat + clinician summary view
    ports: ["3000:80"]
    depends_on: [koboi]
volumes:
  koboi-data:
```

The `/data` volume holds conversation history, and for this app that history is patient health information.
Koboi doesn't encrypt this volume or restrict access to it — that's on Riverside's own IT/ops team, the same
as it would be for any self-hosted database holding patient data.

## config/agent.yaml

```yaml
mode: chat                        # never act or yolo -- this is a live conversation with a patient

server:
  allowed_modes: [chat]           # anything else is rejected with 400 invalid_mode

rag:
  retriever: hybrid
  corpus_path: ./data/seed        # Riverside's triage protocol docs, versioned by clinical staff
  top_k: 8

context:
  strategy: smart_truncation      # always keeps the system prompt + the patient's literal first message
  keep_last: 20                   # plus the most recent 20 messages -- see "don't lose the first message" above

tools:
  custom:
    - module: healthcare_ext.tools   # registers flag_urgent_escalation only

guardrails:
  output:
    - phi_redaction                  # koboi.guardrails entry point, see healthcare_ext/guardrails.py

# tracing intentionally left out: free-text symptom answers can carry PHI a regex
# guardrail won't catch, so this deployment ships with tracing off rather than
# trying to scope it down. Turning it on is a deliberate follow-up decision, not
# a default.
```

## Why it matters

The chat itself is the easy part — koboi's RAG engine handles grounding the conversation in Riverside's own
protocol documents with a few lines of config. What took actual thought was deciding what the agent is
allowed to do, and the answer here is: almost nothing. One tool that can only raise a flag, one guardrail
that keeps sensitive details out of the logs, and everything else left out on purpose. That's the same
pattern as every other sector in this repo — start from what's built in, then extend it narrowly for what
the business actually needs — just with the extension pointed at removing capability instead of adding it.

## Open questions

- **Does a signed BAA exist for the LLM provider Riverside picks?** Koboi supports OpenAI, Anthropic, and
  Cloudflare as providers but makes no compliance claims about any of them — this is a provider-selection
  and contract question for Riverside, not something koboi resolves.
- **Does conversation memory store the raw, un-redacted patient answers?** The `phi_redaction` guardrail in
  this design runs on the output/logging path; whether koboi's SQLite-backed memory keeps the original text
  regardless is worth confirming before treating the guardrail as the only line of defense.
- **How long should patient conversations be kept?** Doc 00's 24-hour session cleanup is about temporary
  workdir housekeeping, not a data-retention policy — Riverside needs its own answer for how long intake
  conversations should exist at all.
- **Should a red-flag symptom get written out immediately instead of waiting in chat history?**
  `smart_truncation` only protects the first message, so firing `flag_urgent_escalation` right away is safer
  than counting on a mid-conversation detail surviving to the end of a long chat.
