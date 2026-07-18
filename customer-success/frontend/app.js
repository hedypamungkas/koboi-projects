// app.js -- Customer-success account-health console. Accounts panel + chat wired to koboi's
// single-agent /v1/chat/stream (SSE), per docs/00-consuming-koboi-server.md Sec.3.
//
// This is the SINGLE-AGENT use case, so koboi's pending_approval DOES surface here -- the
// draft_outreach tool (MODERATE) renders an approve/reject card (POST /v1/sessions/{id}/approve).

const API_BASE = window.KOBOI_API_BASE || "http://localhost:8010";
const API_KEY = window.KOBOI_API_KEY || ""; // auth_required:false for this POC

let sessionId = null;

// Static mirror of cs_ext.tools.py's accounts. `risk` is the UI hint matching the backend score.
const ACCOUNTS = [
  { id: "ACC-7701", name: "Crestline Logistics", csm: "Dana Pierce", renewal: "120d", risk: "low" },
  { id: "ACC-7702", name: "Bluepeak Media", csm: "Dana Pierce", renewal: "38d", risk: "high" },
  { id: "ACC-7703", name: "Northgate Health", csm: "Sam Okafor", renewal: "75d", risk: "medium" },
];

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function renderAccounts() {
  const el = document.getElementById("acct-list");
  el.innerHTML = "";
  for (const a of ACCOUNTS) {
    const card = document.createElement("div");
    card.className = "acct-card";
    card.dataset.risk = a.risk;
    card.innerHTML = `
      <div class="acct-card__top">
        <span class="acct-id">${escapeHtml(a.id)}</span>
        <span class="risk-pill risk-pill--${escapeHtml(a.risk)}">${escapeHtml(a.risk)}</span>
      </div>
      <div class="acct-card__name">${escapeHtml(a.name)}</div>
      <div class="acct-card__meta">csm ${escapeHtml(a.csm)} &middot; renew ${escapeHtml(a.renewal)}</div>
    `;
    card.addEventListener("click", () => {
      document.getElementById("message").value = `Score the churn risk for ${a.id} and recommend an action.`;
      document.getElementById("message").focus();
    });
    el.appendChild(card);
  }
}

const ROLE_LABELS = { user: "You", agent: "Analyst", tool: "System", error: "Error" };

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

function riskClass(risk) {
  const r = String(risk || "").toLowerCase();
  if (r.includes("destructive")) return "destructive";
  if (r.includes("moderate")) return "moderate";
  return "safe";
}

function formatApprovalArguments(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rows = Object.entries(parsed)
        .map(([k, v]) => {
          const val = typeof v === "string" ? v : JSON.stringify(v);
          return `<div class="kv-key">${escapeHtml(k)}</div><div class="kv-val">${escapeHtml(val)}</div>`;
        })
        .join("");
      return `<div class="kv-grid">${rows}</div>`;
    }
  } catch (e) { /* fall through */ }
  return `<pre>${escapeHtml(raw)}</pre>`;
}

function addApprovalCard(evt) {
  const chat = document.getElementById("chat");
  const card = document.createElement("div");
  const risk = riskClass(evt.risk_level);
  card.className = `approval-card risk-${risk}`;
  card.innerHTML = `
    <div class="approval-card__head">
      <span class="approval-card__icon" aria-hidden="true">&#9888;</span>
      <div>
        <div class="title">Approve outreach draft: ${escapeHtml(evt.tool_name)}</div>
        <span class="risk-pill-tag">${escapeHtml(evt.risk_level)} risk</span>
      </div>
    </div>
    <div class="approval-card__body">${formatApprovalArguments(evt.arguments)}</div>
    <div class="approval-card__actions">
      <button type="button" class="approve-btn">Approve</button>
      <button type="button" class="reject-btn">Reject</button>
    </div>
  `;
  chat.appendChild(card);
  chat.scrollTop = chat.scrollHeight;

  const resolve = async (decision) => {
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const headers = { "Content-Type": "application/json" };
      if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
      const res = await fetch(`${API_BASE}/v1/sessions/${sessionId}/approve`, {
        method: "POST", headers,
        body: JSON.stringify({ approval_id: evt.approval_id, decision, scope: "once" }),
      });
      const body = await res.json();
      card.querySelector(".title").textContent += body.resolved ? ` -- ${decision}d` : " -- failed to resolve";
    } catch (err) {
      card.querySelector(".title").textContent += ` -- error: ${err}`;
    }
  };
  card.querySelector(".approve-btn").addEventListener("click", () => resolve("approve"));
  card.querySelector(".reject-btn").addEventListener("click", () => resolve("deny"));
}

const STREAM_TIMEOUT_MS = 90_000;

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
    onEvent({ type: "error", error: timedOut ? "Request timed out -- please try again." : String(err) });
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
    onEvent({ type: "error", error: timedOut ? "Request timed out -- please try again." : String(err) });
  }
}

async function sendMessage(message) {
  addMessage("user", message);
  let agentBubble = null;
  const thinking = addThinkingIndicator();
  let cleared = false;
  const clear = () => { if (!cleared) { cleared = true; thinking.remove(); } };
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
        case "pending_approval":
          addApprovalCard(evt);
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

renderAccounts();
