// app.js -- Northwind employee concierge front door. Chat wired to the concierge koboi
// instance /v1/chat/stream (SSE). The concierge fans requests out to the IT / Facilities
// peer instances via the builtin call_peer_agent tool -- those show up as tool_call events.

const API_BASE = window.KOBOI_API_BASE || "http://localhost:8009";
// A2A-enabled servers REQUIRE auth (outbound peers => peer_registry.has_peers => a Bearer token
// is mandatory on every endpoint; auth_required:false can't override it). The concierge's API key
// comes from CONCIERGE_API_KEY in .env (default below matches .env.example). Override at runtime
// by setting window.KOBOI_API_KEY before this script loads.
const API_KEY = window.KOBOI_API_KEY || "concierge-smoke-key-1234";

let sessionId = null;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const ROLE_LABELS = { user: "You", agent: "Concierge", tool: "Routing", error: "Error" };

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
  wrap.innerHTML = `<div class="msg-label">Concierge</div><div class="bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>`;
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}

// call_peer_agent round-trips to another container, so allow a bit more time than a plain chat.
const STREAM_TIMEOUT_MS = 150_000;

async function streamChat(message, onEvent) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  if (sessionId) headers["X-Session-Id"] = sessionId;
  let res;
  try {
    res = await fetch(`${API_BASE}/v1/chat/stream`, {
      method: "POST", headers,
      body: JSON.stringify({ message, mode: "act" }),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    onEvent({ type: "error", error: timedOut ? "Request timed out -- please retry." : String(err) });
    return;
  }
  const newSid = res.headers.get("X-Session-Id");
  if (newSid) {
    sessionId = newSid;
    document.getElementById("session-id").textContent = `session: ${sessionId.slice(0, 8)}`;
    document.getElementById("conn-dot").classList.add("active");
  }
  if (!res.ok || !res.body) { onEvent({ type: "error", error: `HTTP ${res.status}` }); return; }
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
        try { onEvent(JSON.parse(line.slice(6))); } catch (e) { console.warn("bad SSE frame", line, e); }
      }
    }
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    onEvent({ type: "error", error: timedOut ? "Request timed out -- please retry." : String(err) });
  }
}

async function sendMessage(message) {
  addMessage("user", message);
  const thinking = addThinkingIndicator();
  let cleared = false;
  const clear = () => { if (!cleared) { cleared = true; thinking.remove(); } };
  let agentBubble = null;
  try {
    await streamChat(message, (evt) => {
      clear();
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
          if (!agentBubble && evt.content) addMessage("agent", evt.content);
          break;
        case "error":
          addMessage("error", `Error: ${evt.error || JSON.stringify(evt)}`);
          break;
        default:
          console.log("event", evt);
      }
    });
  } finally {
    clear();
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

document.querySelectorAll(".quick button[data-q]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("message").value = btn.dataset.q;
    document.getElementById("message").focus();
  });
});
