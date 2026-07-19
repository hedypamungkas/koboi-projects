# How These Apps Work

> Shared by every use case in this repo. Read this once — the sector docs only describe what's different.

Each use case here is a small **full-stack app**: a web frontend, a koboi-agent backend (in Docker), and a
thin layer of business logic on top. The point we're making with all six: **koboi is easy to start with
what's built in, and just as easy to extend when a business needs something custom.** Same codebase, both
stories — no fork, no rewrite.

---

## 1. The shape of every app here

```
   Browser (web UI)  ──HTTPS──▶  koboi server (Docker, one container)  ──▶  Tools / RAG / Memory
   chat widget or                runs your config.yaml + your                built-in, or your own
   dashboard                     custom tools/hooks/retrievers               business logic
```

- **Frontend** — plain web app (any stack; examples below use vanilla JS to keep it dependency-free). Talks
  to koboi over HTTP/SSE, nothing more.
- **Backend** — koboi-agent itself, self-hosted in one Docker container. Configured by one YAML file.
- **Your code** — a small installable Python package with your business-specific tools, hooks, or a custom
  data retriever. koboi core is never modified.

## 2. Two ways to run a turn

| | Chat (a person is present) | Job (runs on its own) |
|---|---|---|
| Call | `POST /v1/chat/stream` | `POST /v1/jobs` |
| Response | Streams live (SSE) | Poll `GET /v1/jobs/{id}` or tail `GET /v1/jobs/{id}/stream` |
| Can pause for approval? | Yes — a `pending_approval` event, resolved via `POST /v1/sessions/{id}/approve` | No — runs unattended, so anything risky needs to be designed out or logged, not approved mid-run |
| Use for | Live chat, support, Q&A | Nightly batches, bulk processing, scheduled work |

Both accept `{"message": "...", "mode": "chat|plan|act|auto", "max_iterations": 10}`. `mode` is checked
against `server.allowed_modes`; jobs can never run in `yolo` mode, no matter what.

**A naming collision worth knowing before you configure anything:** "chat" here means the *transport*
(`/v1/chat/stream`, a live SSE conversation). But `mode` is a *different* thing — koboi's own permission
level (`chat`/`plan`/`act`/`auto`/`yolo`), and `AgentMode.CHAT` is a locked-down, read-only mode that blocks
every custom tool by name, regardless of its risk level. An app with a custom tool picks one of two routes:
set `agent.mode: act` (every tool may run; `MODERATE`/`DESTRUCTIVE` tools still pause for human approval),
**or** keep a `chat`/`plan` default and allowlist its SAFE custom tools via `mode.read_only_tools: [...]` —
the escape hatch koboi 0.18+ added to ModeHook's built-in read-only set (wired in `hooks/registry.py`). Use
`act` when any custom tool is `MODERATE`/`DESTRUCTIVE`; a bare `chat` default fits an agent whose custom tools
are all SAFE. Most apps in this repo use `act`; healthcare is the SAFE-only exception and runs in `chat` +
`mode.read_only_tools` (see its README).

## 3. Streaming to the browser

The server sends `data: {...}\n\n` messages and always ends with `data: [DONE]\n\n`. A minimal frontend
just reads the stream and reacts to `type`:

```js
// shared by every frontend in this repo — sector docs only add UI on top of this
async function streamChat(message, onEvent) {
  const res = await fetch("/v1/chat/stream", {
    method: "POST",
    headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split("\n\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      onEvent(JSON.parse(line.slice(6))); // { type: "text_delta" | "tool_call" | "pending_approval" | ... }
    }
  }
}
```

Event types you'll actually handle: `text_delta` (append to the chat bubble), `tool_call`/`tool_result`
(show a small "checking order status..." indicator), `pending_approval` (show an approve/reject button),
`complete` (final message + stats), `error`.

## 4. Auth

Every request carries `Authorization: Bearer <token>`. Create a token once:

```bash
docker compose run --rm koboi koboi keys create --label prod
```

There are no scopes — a token identifies who's calling, not what they're allowed to do.

## 5. What's built in vs. what you write

koboi ships a working agent (memory, RAG, guardrails, human-approval flow, sandboxing) out of the box.
You add business logic in three ways, all from your own Python package — no core changes:

| You want to... | You write | You wire it up with |
|---|---|---|
| Call an internal API/system | a **tool**: `@tool(name=, description=, parameters=, risk_level=)` | `tools.custom: [{module: your_pkg.tools}]` in YAML |
| Search your own knowledge base | a **retriever**: `@register_retriever("name")`, subclass `BaseRetriever` | `rag.retriever: name`, `rag.custom_modules: [...]` in YAML |
| Log, redact, or block on tool use | a **hook**: subclass `Hook`, handle events like `PRE_TOOL_USE`/`POST_TOOL_USE` | your own small entrypoint script, not the bare `koboi serve` CLI (see below) |
| Filter content in/out | a **guardrail**: subclass `PatternGuardrail` | registered via a Python entry point in your package |

Tools carry a risk level — `SAFE`, `MODERATE`, or `DESTRUCTIVE`. Over the chat transport, `SAFE` runs
immediately; **`MODERATE` and `DESTRUCTIVE` both pause for human approval** (a `pending_approval` event,
resolved via `POST /v1/sessions/{id}/approve`) — it's not just the destructive ones. Jobs never pause for
anything, at any risk level, since no one's watching — that's the real reason to keep a truly autonomous
workflow's tools at `SAFE`/`MODERATE` and route anything that needs a human's eyes through chat instead.

**Wiring a hook — there's no YAML key for this.** Unlike tools/RAG/context, hooks can't be preloaded via
`koboi serve <config>`. Write a small entrypoint script instead:
```python
import uvicorn
from koboi.config import Config
from koboi.server.app import create_app
from your_pkg.hooks import MyHook

cfg = Config.from_yaml("config/agent.yaml")
hook = MyHook()
app = create_app(cfg, extra_hooks=[(hook.execute, hook.handles())])  # a (callback, events) tuple —
uvicorn.run(app, host="0.0.0.0", port=8000)                          # NOT the bare Hook instance
```
Point your Dockerfile's `CMD` at this script instead of `koboi serve`. Inside the hook itself,
`ctx.tool_arguments` arrives as a **JSON string**, not a dict — `json.loads()` it before reading a field.

**Note on MCP tools specifically:** if you connect koboi to an MCP server (yours or a vendor's) instead of
writing a local `@tool()`, that server's tools default to `SAFE` — but koboi 0.18+ can risk-gate the whole
server via `mcp.servers[].risk_level`, or infer per-tool risk with `risk_heuristic: true` (a non-SAFE level
then gates when `guardrails.approval` or `policy.rules` is configured). Read-only lookups are fine as MCP;
for the one operation a human must approve, a local `@tool()` carrying `RiskLevel.DESTRUCTIVE` is still the
most direct way to get the approval pause. The finance doc shows exactly this split.

## 6. Guardrails you get without writing code

Three protections are plain YAML flags — no Python, no subclassing:

| Config | What it does |
|---|---|
| `guardrails.input: {detect_injection: true}` | Blocks common prompt-injection patterns ("ignore previous instructions", role-spoofing, etc.) before the message reaches the model |
| `guardrails.output: {detect_sensitive: true}` | Flags API keys, passwords, and card numbers in the model's reply |
| `guardrails.rate_limit: {max_calls_per_minute: 20}` | Caps how often one caller can hit the agent |

These cover the generic cases. Anything business-specific — redacting a patient's date of birth, blocking a
particular clause pattern — needs a custom guardrail (`PatternGuardrail` subclass, doc §5's table). The
healthcare doc shows exactly where that line falls: the built-in filter catches secrets, not PHI.

## 7. Three more building blocks, used where they fit

You won't need all of these in one app — each sector doc below uses one or two where they're a natural fit.

- **MCP** — instead of writing a tool that calls an internal API directly, point koboi at an MCP server (a
  small standard-protocol service) that already exposes those operations. Useful when a system is shared
  across multiple internal tools, not just this agent. koboi only ever *connects to* MCP servers — if you
  need one, you build and host it yourself, separate from koboi. Two transports exist in the code
  (`command`/`args` stdio subprocess, and `url`/`transport: streamable-http` for a separately-hosted
  service) — **only the stdio form has a proven working example to copy from**; the finance app in this repo
  runs its MCP server as a stdio subprocess co-located in the same container for exactly that reason, not
  because that's the ideal production shape.
- **Skills** — a folder with a `SKILL.md` file (plain Markdown + a few YAML fields) instead of code. Point
  `skills.search_paths` at the folder, and koboi surfaces the right skill to the model based on what the
  conversation is about. Good for packaging a playbook or set of instructions that doesn't need any tool
  calls — just knowledge and a process to follow.
- **Fan-out (`delegate_tasks`)** — a built-in tool the agent can call itself, mid-run, to process several
  independent items in parallel (up to 10 per call) instead of one at a time. Useful inside a single job that
  covers a batch of similar work. **`tools.builtin` is a hard gate, not a default-on allowlist** — an
  empty/unset list means *zero* builtin tools, `delegate_tasks` included. List it explicitly:
  `tools.builtin: [delegate_tasks]`.

## 8. Docker, end to end

`koboi-agent` is a real, published PyPI package — `pip install "koboi-agent[api]==<version>"` is the whole
dependency story. No git checkout, no local wheel, no vendoring anything into your own repo.

```yaml
# docker-compose.yml — the pattern every use case follows
services:
  koboi:
    build:
      context: .                    # your project root — Dockerfile needs to reach pyproject.toml/src/config
      dockerfile: backend/Dockerfile
    ports: ["8000:8000"]
    volumes: ["koboi-data:/data"]   # memory db, keys, session files — must persist
    env_file: .env
  web:
    build: ./frontend               # static build served by nginx (or any web server)
    ports: ["3000:80"]
    depends_on: [koboi]
volumes:
  koboi-data:
```

```dockerfile
# backend/Dockerfile
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "koboi-agent[api]==<version>"
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e .
COPY config ./config
EXPOSE 8000
CMD ["koboi", "serve", "config/agent.yaml", "--host", "0.0.0.0", "--port", "8000"]
```

That's the entire backend deployment — koboi-agent from PyPI, your own package installed on top, `koboi serve`
(or your custom entrypoint script if the app uses a hook — see §5). Pin the version explicitly; bump it
deliberately, not by accident on a routine rebuild.

**The frontend and backend are always different origins** (different containers, different ports) — the
browser will silently fail to call the API, or silently lose the session between turns, without an explicit
CORS config:
```yaml
server:
  cors:
    allow_origins: ["*"]              # scope this down in production
    expose_headers: ["X-Session-Id"]  # without this the browser can't read the session id — every
                                       # "turn" starts a new session instead of continuing one
```

## 9. What to know before you ship

- **One server, one process.** No load balancing or multi-node yet — right-sized for one company's traffic,
  not a shared SaaS platform.
- **Jobs can't pause for a human, and jobs require `sandbox.backend: restricted`.** The server refuses to
  start a job at all on the default `passthrough` sandbox — this isn't optional hardening, it's a hard
  requirement for `POST /v1/jobs` to work. Design anything a job does to be safe unattended, or route the
  risky step into chat mode instead.
- **Webhooks are opt-in.** koboi 0.18+ can POST an HMAC-signed (`X-Koboi-Signature`) payload to a
  `jobs.webhooks[]` URL when a job reaches a terminal status; otherwise poll `GET /v1/jobs/{id}` or tail
  `/v1/jobs/{id}/stream`. None of the apps in this repo wire one up.
- **Files live per-session and expire** (24h default) — nothing is a permanent file store.

That's the whole contract. Everything past this point in each sector doc is what makes that business
different: which tools it needs, what its UI looks like, and where the "built-in vs. custom" line falls.

**Everything on this page has been verified against a real, running build** — all 10 apps are built, in the
sibling project directories (`../ecommerce-support/`, `../hr-screening/`, etc.), each with a working
`docker-compose.yml` and a `README.md` documenting the couple of sector-specific details that came up when
actually running it. If something here and a sector doc ever disagree, the running project's README is the
one that's been tested.
