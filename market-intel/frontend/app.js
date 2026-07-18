// app.js -- Northwind Strategy market-intel console. Watchlist + chat wired to koboi's
// orchestrated deep_research /v1/chat/stream, plus a "Run weekly brief" button that submits
// an autonomous deep-research job (POST /v1/jobs) and tails its stream.

const API_BASE = window.KOBOI_API_BASE || "http://localhost:8008";
const API_KEY = window.KOBOI_API_KEY || ""; // auth_required:false for this POC

let sessionId = null;

const WATCHLIST = {
  primary: ["Acme Cloud", "Brightline Ops", "Coreway Systems"],
  focus: ["pricing", "product launches", "earnings", "hires", "regulatory"],
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function renderChips() {
  const render = (id, items, prefix) => {
    const el = document.getElementById(id);
    el.innerHTML = "";
    for (const t of items) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = t;
      chip.addEventListener("click", () => {
        const input = document.getElementById("message");
        input.value = `${prefix} ${t} this quarter.`;
        input.focus();
      });
      el.appendChild(chip);
    }
  };
  render("chips-primary", WATCHLIST.primary, "Research");
  render("chips-focus", WATCHLIST.focus, "Summarize what changed in");
}

const ROLE_LABELS = { user: "You", agent: "Analyst", tool: "Research", error: "Error" };

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
  wrap.innerHTML = `<div class="msg-label">Analyst</div><div class="bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>`;
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}

// deep_research fans out many search/fetch nodes and can run long against a slow gateway.
const STREAM_TIMEOUT_MS = 240_000;

async function streamSSE(res, onEvent) {
  const newSid = res.headers.get("X-Session-Id");
  if (newSid) {
    sessionId = newSid;
    document.getElementById("session-id").textContent = `session: ${sessionId}`;
    document.getElementById("conn-dot").classList.add("active");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
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
}

function handleEvent(evt, agentBubbleRef) {
  let agentBubble = agentBubbleRef.value;
  switch (evt.type) {
    case "text_delta":
      if (!agentBubble) agentBubble = addMessage("agent", "");
      agentBubble.textContent += evt.content;
      agentBubbleRef.value = agentBubble;
      break;
    case "tool_call":
      addMessage("tool", `-> ${evt.tool_name}(${evt.arguments})`);
      break;
    case "tool_result":
      addMessage("tool", `<- ${evt.tool_name}: ${evt.result}`);
      break;
    case "complete":
      // deep_research returns the synthesized cited brief, often entirely in `complete`.
      if (!agentBubble && evt.content) addMessage("agent", evt.content);
      break;
    case "error":
      addMessage("error", `Error: ${evt.error || JSON.stringify(evt)}`);
      break;
    default:
      console.log("event", evt);
  }
}

async function sendMessage(message) {
  addMessage("user", message);
  const thinking = addThinkingIndicator();
  let cleared = false;
  const clear = () => { if (!cleared) { cleared = true; thinking.remove(); } };
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  if (sessionId) headers["X-Session-Id"] = sessionId;
  const bubbleRef = { value: null };
  try {
    const res = await fetch(`${API_BASE}/v1/chat/stream`, {
      method: "POST", headers,
      body: JSON.stringify({ message, mode: "act" }),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) { clear(); addMessage("error", `HTTP ${res.status}`); return; }
    await streamSSE(res, (evt) => { clear(); handleEvent(evt, bubbleRef); });
  } catch (err) {
    clear();
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    addMessage("error", timedOut ? "Research timed out -- try narrowing the scope." : String(err));
  } finally {
    clear();
  }
}

// Submit an autonomous deep-research job and tail its stream (POST /v1/jobs then
// GET /v1/jobs/{id}/stream). Jobs never pause for a human; the finished brief is also
// HMAC-POSTed to the configured webhook (see README).
async function runWeeklyBrief() {
  const btn = document.getElementById("run-brief");
  btn.disabled = true;
  btn.textContent = "Running…";
  addMessage("user", "Run this week's competitive brief (autonomous job).");
  const thinking = addThinkingIndicator();
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  const bubbleRef = { value: null };
  try {
    const submit = await fetch(`${API_BASE}/v1/jobs`, {
      method: "POST", headers,
      body: JSON.stringify({
        message:
          "Research this week's tracked competitors (call get_tracked_competitors first) across " +
          "pricing, launches, earnings, people, and regulatory moves. Synthesize a tight cited " +
          "brief with numbered citations, then call publish_brief with it.",
        mode: "act",
      }),
    });
    if (!submit.ok) { thinking.remove(); addMessage("error", `Job submit failed: HTTP ${submit.status}`); return; }
    const { job_id } = await submit.json();
    addMessage("tool", `-> submitted job ${job_id}`);
    const streamRes = await fetch(`${API_BASE}/v1/jobs/${job_id}/stream`, {
      headers: { ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
    if (streamRes.ok && streamRes.body) {
      await streamSSE(streamRes, (evt) => { thinking.remove(); handleEvent(evt, bubbleRef); });
    } else {
      thinking.remove();
      addMessage("tool", `<- job ${job_id} submitted; poll GET /v1/jobs/${job_id} for the result.`);
    }
  } catch (err) {
    thinking.remove();
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    addMessage("error", timedOut ? "Brief job timed out -- it may still be running; check /v1/jobs." : String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Run weekly brief";
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

document.getElementById("run-brief").addEventListener("click", () => runWeeklyBrief());

renderChips();
