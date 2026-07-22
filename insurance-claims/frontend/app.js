// app.js -- Beacon Mutual claims-triage console (case-file/ledger UI).
// Vanilla JS, talks to koboi's single-agent /v1/chat/stream (SSE). See docs/00 §3.

const API_BASE = window.KOBOI_API_BASE || (window.location.port === "3007" ? `${window.location.protocol}//${window.location.hostname}:8007` : "");
const API_KEY = window.KOBOI_API_KEY || ""; // auth_required:false for this POC

let sessionId = null;

// Mirror of claims_ext.tools.py's in-memory claim store (UI hint severity mirrors backend cues).
const CLAIMS = [
  { id: "CLM-501", holder: "A. Rivera", loss: "Rear-end collision, low speed", severity: "low" },
  { id: "CLM-502", holder: "M. Okafor", loss: "Single-vehicle collision, total loss", severity: "high" },
  { id: "CLM-503", holder: "T. Lindqvist", loss: "Hit while parked, late-reported", severity: "medium" },
  { id: "CLM-504", holder: "S. Chen", loss: "Road debris cracked windshield", severity: "low" },
];

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const ROLE = { user: "From Adjuster", agent: "Triage Memo", tool: "Of Record", error: "Notice" };

function renderClaimList() {
  const el = document.getElementById("claim-list");
  el.innerHTML = "";
  CLAIMS.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "ledger-row";
    row.innerHTML = `
      <div class="row-idx">No. ${String(i + 1).padStart(2, "0")}</div>
      <div class="row-body">
        <div class="row-id">${escapeHtml(c.id)}</div>
        <div class="row-holder">${escapeHtml(c.holder)}</div>
        <div class="row-loss">${escapeHtml(c.loss)}</div>
      </div>
      <div class="sev ${escapeHtml(c.severity)}">${escapeHtml(c.severity)}</div>
    `;
    row.addEventListener("click", () => {
      const input = document.getElementById("message");
      input.value = `Triage claim ${c.id} and route it.`;
      input.focus();
    });
    el.appendChild(row);
  });
}

function addEntry(role, text) {
  const chat = document.getElementById("chat");
  const entry = document.createElement("div");
  entry.className = `entry ${role}`;
  const label = document.createElement("div");
  label.className = "role";
  label.textContent = ROLE[role] || role;
  const body = document.createElement("div");
  body.className = "body";
  if (role === "tool") {
    if (text.startsWith("->")) { body.classList.add("call"); text = text.replace(/^->\s*/, ""); }
    else if (text.startsWith("<-")) { body.classList.add("result"); text = text.replace(/^<-\s*/, ""); }
  }
  body.textContent = text;
  entry.appendChild(label);
  entry.appendChild(body);
  chat.appendChild(entry);
  chat.scrollTop = chat.scrollHeight;
  return body;
}

function addThinking() {
  const chat = document.getElementById("chat");
  const entry = document.createElement("div");
  entry.className = "entry agent thinking";
  entry.innerHTML = `<div class="role">${ROLE.agent}</div><div class="body"><span class="d">·</span><span class="d">·</span><span class="d">·</span> reviewing the file</div>`;
  chat.appendChild(entry);
  chat.scrollTop = chat.scrollHeight;
  return entry;
}

function fmtArgs(raw) {
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === "object" && !Array.isArray(p)) {
      return `<div class="kv">${Object.entries(p).map(([k, v]) =>
        `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(typeof v === "string" ? v : JSON.stringify(v))}</div>`).join("")}</div>`;
    }
  } catch (e) {}
  return `<pre>${escapeHtml(raw)}</pre>`;
}

function addApproval(evt) {
  const chat = document.getElementById("chat");
  const a = document.createElement("div");
  a.className = "approval";
  a.innerHTML = `
    <div class="approval__body">
      <div class="t">Action: ${escapeHtml(evt.tool_name)}</div>
      ${fmtArgs(evt.arguments)}
    </div>
    <div class="approval__actions">
      <button type="button" class="approve">Approve &amp; file</button>
      <button type="button" class="reject">Return to desk</button>
    </div>
  `;
  chat.appendChild(a);
  chat.scrollTop = chat.scrollHeight;
  const resolve = async (d) => {
    a.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const h = { "Content-Type": "application/json" };
      if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
      const res = await fetch(`${API_BASE}/v1/sessions/${sessionId}/approve`, {
        method: "POST", headers: h, body: JSON.stringify({ approval_id: evt.approval_id, decision: d, scope: "once" }),
      });
      const b = await res.json();
      a.querySelector(".t").textContent += b.resolved ? ` — ${d === "approve" ? "filed" : "returned"}` : " — could not resolve";
    } catch (e) { a.querySelector(".t").textContent += ` — error: ${e}`; }
  };
  a.querySelector(".approve").addEventListener("click", () => resolve("approve"));
  a.querySelector(".reject").addEventListener("click", () => resolve("deny"));
}

const STREAM_TIMEOUT_MS = 120_000;

async function streamChat(message, onEvent) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  if (sessionId) headers["X-Session-Id"] = sessionId;
  let res;
  try {
    res = await fetch(`${API_BASE}/v1/chat/stream`, {
      method: "POST", headers, body: JSON.stringify({ message, mode: "act" }),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const t = err.name === "TimeoutError" || err.name === "AbortError";
    onEvent({ type: "error", error: t ? "The bureau timed out — please refile." : String(err) });
    return;
  }
  const sid = res.headers.get("X-Session-Id");
  if (sid) {
    sessionId = sid;
    document.getElementById("session-id").textContent = `file #${sid.slice(0, 10)}`;
    document.getElementById("conn-dot").classList.add("on");
  }
  if (!res.ok || !res.body) { onEvent({ type: "error", error: `HTTP ${res.status}` }); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const line of parts) {
        if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
        try { onEvent(JSON.parse(line.slice(6))); } catch (e) { console.warn("bad SSE", line, e); }
      }
    }
  } catch (err) {
    const t = err.name === "TimeoutError" || err.name === "AbortError";
    onEvent({ type: "error", error: t ? "The bureau timed out — please refile." : String(err) });
  }
}

async function send(message) {
  addEntry("user", message);
  let bubble = null;
  const think = addThinking();
  let cleared = false;
  const clear = () => { if (!cleared) { cleared = true; think.remove(); } };
  try {
    await streamChat(message, (evt) => {
      clear();
      switch (evt.type) {
        case "text_delta":
          if (!bubble) bubble = addEntry("agent", "");
          bubble.textContent += evt.content;
          break;
        case "tool_call": addEntry("tool", `-> ${evt.tool_name}(${evt.arguments})`); break;
        case "tool_result": addEntry("tool", `<- ${evt.tool_name}: ${evt.result}`); break;
        case "pending_approval": addApproval(evt); break;
        case "complete": if (!bubble && evt.content) addEntry("agent", evt.content); break;
        case "error": addEntry("error", `Error: ${evt.error || JSON.stringify(evt)}`); break;
        default: console.log("event", evt);
      }
    });
  } finally { clear(); }
}

document.getElementById("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("message");
  const m = input.value.trim();
  if (!m) return;
  input.value = "";
  send(m).catch((err) => addEntry("error", `Error: ${err}`));
});

renderClaimList();
