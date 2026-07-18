// app.js -- Beacon Mutual claims-triage console. Static FNOL queue + chat wired to
// koboi's single-agent /v1/chat/stream (SSE), per docs/00-consuming-koboi-server.md Sec.3.
//
// Single-agent (not orchestrated): the triage runs as one agent that calls its tools directly
// (lookup_claim / estimate_repair_cost / screen_fraud / record_recommendation). See README
// "Why single-agent, not a DAG". tool_call/tool_result + the final triage summary all stream
// over /v1/chat/stream and are rendered below.

const API_BASE = window.KOBOI_API_BASE || "http://localhost:8007";
const API_KEY = window.KOBOI_API_KEY || ""; // auth_required:false for this POC -- see README

let sessionId = null;

// Static mirror of claims_ext.tools.py's in-memory claim store (the nightly triage job
// that would populate this panel via /v1/jobs is exercised through curl in the README).
// `severity` is a UI hint derived from the seed data, mirroring the fraud/value cues the
// backend scores -- not a separate fact.
const CLAIMS = [
  { id: "CLM-501", holder: "A. Rivera", loss: "Rear-end collision, low speed", severity: "low" },
  { id: "CLM-502", holder: "M. Okafor", loss: "Single-vehicle collision, total loss", severity: "high" },
  { id: "CLM-503", holder: "T. Lindqvist", loss: "Hit while parked, late-reported", severity: "medium" },
  { id: "CLM-504", holder: "S. Chen", loss: "Road debris cracked windshield", severity: "low" },
];

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function renderClaimList() {
  const el = document.getElementById("claim-list");
  el.innerHTML = "";
  for (const c of CLAIMS) {
    const card = document.createElement("div");
    card.className = "claim-card";
    card.dataset.severity = c.severity;
    card.innerHTML = `
      <div class="claim-card__top">
        <span class="claim-id">${escapeHtml(c.id)}</span>
        <span class="sev-pill sev-pill--${escapeHtml(c.severity)}">${escapeHtml(c.severity)}</span>
      </div>
      <div class="claim-card__holder">${escapeHtml(c.holder)}</div>
      <div class="claim-card__loss">${escapeHtml(c.loss)}</div>
    `;
    card.addEventListener("click", () => {
      const input = document.getElementById("message");
      input.value = `Triage claim ${c.id} and route it.`;
      input.focus();
    });
    el.appendChild(card);
  }
}

const ROLE_LABELS = { user: "You", agent: "Triage", tool: "System", error: "Error" };

function addMessage(role, text) {
  const chat = document.getElementById("chat");
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = ROLE_LABELS[role] || role;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "tool") {
    if (text.startsWith("->")) bubble.classList.add("tool-call");
    else if (text.startsWith("<-")) bubble.classList.add("tool-result");
  }
  bubble.textContent = text;
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

function addThinkingIndicator() {
  const chat = document.getElementById("chat");
  const wrap = document.createElement("div");
  wrap.className = "msg agent thinking";
  wrap.innerHTML = `
    <div class="msg-label">Triage</div>
    <div class="bubble">
      <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
    </div>
  `;
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}

// Shared streamChat() from doc 00 Sec.3, carrying X-Session-Id across turns and pinning
// mode:"act" (CHAT mode blocks every custom tool by name; act lets the orchestrator's
// tools run). Same 90s timeout guard as the other apps in this repo.
const STREAM_TIMEOUT_MS = 120_000; // orchestrated triage fans out to several nodes -- give it room

async function streamChat(message, onEvent) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  if (sessionId) headers["X-Session-Id"] = sessionId;

  let res;
  try {
    res = await fetch(`${API_BASE}/v1/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, mode: "act" }),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    onEvent({ type: "error", error: timedOut ? "Triage timed out -- please retry." : String(err) });
    return;
  }

  const newSid = res.headers.get("X-Session-Id");
  if (newSid) {
    sessionId = newSid;
    document.getElementById("session-id").textContent = `session: ${sessionId}`;
    const dot = document.getElementById("conn-dot");
    if (dot) dot.classList.add("active");
  }

  if (!res.ok || !res.body) {
    onEvent({ type: "error", error: `HTTP ${res.status}` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const line of parts) {
        if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch (e) {
          console.warn("bad SSE frame", line, e);
        }
      }
    }
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    onEvent({ type: "error", error: timedOut ? "Triage timed out -- please retry." : String(err) });
  }
}

async function sendMessage(message) {
  addMessage("user", message);
  let agentBubble = null;
  const thinking = addThinkingIndicator();
  let thinkingCleared = false;
  const clearThinking = () => {
    if (!thinkingCleared) {
      thinkingCleared = true;
      thinking.remove();
    }
  };

  try {
    await streamChat(message, (evt) => {
      clearThinking();
      switch (evt.type) {
        case "text_delta":
          if (!agentBubble) agentBubble = addMessage("agent", "");
          agentBubble.textContent += evt.content;
          break;
        case "tool_call":
          addMessage("tool", `-> ${evt.tool_name}(${evt.arguments})`);
          break;
        case "tool_result":
          addMessage("tool", `<- ${evt.tool_name}: ${evt.result}`);
          break;
        case "complete":
          // The orchestrator's final synthesized recommendation may arrive entirely in the
          // complete event (not streamed as text_delta). Handle both shapes.
          if (!agentBubble && evt.content) {
            addMessage("agent", evt.content);
          }
          break;
        case "error":
          addMessage("error", `Error: ${evt.error || JSON.stringify(evt)}`);
          break;
        default:
          console.log("event", evt);
      }
    });
  } finally {
    clearThinking();
  }
}

document.getElementById("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("message");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  sendMessage(message).catch((err) => addMessage("error", `Error: ${err}`));
});

renderClaimList();
