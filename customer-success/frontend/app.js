// app.js -- Account Health observatory (dark vitals UI). Vanilla JS, talks to koboi's
// single-agent /v1/chat/stream (SSE). Parses the structured churn-risk JSON into a vitals readout.

const API_BASE = window.KOBOI_API_BASE || (window.location.port === "3010" ? `${window.location.protocol}//${window.location.hostname}:8010` : "");
const API_KEY = window.KOBOI_API_KEY || ""; // auth_required:false for this POC

let sessionId = null;

const ACCOUNTS = [
  { id: "ACC-7701", name: "Crestline Logistics", csm: "Dana Pierce", renewal: "120d", risk: "low" },
  { id: "ACC-7702", name: "Bluepeak Media", csm: "Dana Pierce", renewal: "38d", risk: "high" },
  { id: "ACC-7703", name: "Northgate Health", csm: "Sam Okafor", renewal: "75d", risk: "medium" },
];

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

function renderAccounts() {
  document.getElementById("acct-count").textContent = `· ${ACCOUNTS.length}`;
  const el = document.getElementById("acct-list");
  el.innerHTML = "";
  for (const a of ACCOUNTS) {
    const card = document.createElement("div");
    card.className = "acct";
    card.dataset.risk = a.risk;
    card.innerHTML = `
      <div class="top"><span class="id">${escapeHtml(a.id)}</span></div>
      <div class="name">${escapeHtml(a.name)}</div>
      <div class="meta"><span>CSM ${escapeHtml(a.csm)}</span><span>renew ${escapeHtml(a.renewal)}</span></div>
      <div class="meter"><i></i></div>
      <span class="tag"><span class="d"></span>${escapeHtml(a.risk)} risk</span>
    `;
    card.addEventListener("click", () => {
      document.getElementById("message").value = `Score the churn risk for ${a.id} and recommend an action.`;
      document.getElementById("message").focus();
    });
    el.appendChild(card);
  }
}

const ROLE = { user: "You", agent: "Analyst", tool: "Sensor", error: "Fault" };

function msg(role, text) {
  const chat = document.getElementById("chat");
  const m = document.createElement("div");
  m.className = `m ${role}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = ROLE[role] || role;
  const body = document.createElement("div");
  body.className = "body";
  if (role === "tool") {
    if (text.startsWith("->")) { body.classList.add("call"); text = text.replace(/^->\s*/, ""); }
    else if (text.startsWith("<-")) text = text.replace(/^<-\s*/, "");
  }
  body.textContent = text;
  m.appendChild(who); m.appendChild(body);
  chat.appendChild(m); chat.scrollTop = chat.scrollHeight;
  return body;
}

function thinking() {
  const chat = document.getElementById("chat");
  const m = document.createElement("div");
  m.className = "m agent thinking";
  m.innerHTML = `<div class="who">${ROLE.agent}</div><div class="body"><span class="d">·</span><span class="d">·</span><span class="d">·</span> reading vitals</div>`;
  chat.appendChild(m); chat.scrollTop = chat.scrollHeight;
  return m;
}

function vitalsReadout(o) {
  const chat = document.getElementById("chat");
  const r = document.createElement("div");
  r.className = "readout";
  r.dataset.risk = o.risk_level || "medium";
  r.innerHTML = `
    <div class="rh">
      <div class="score">${escapeHtml(String(o.churn_risk_score ?? "–"))}<small>/100</small></div>
      <div class="right">
        <span class="lvl">${escapeHtml(o.risk_level || "")} risk</span>
        <div class="act">action · <b>${escapeHtml((o.recommended_action || "").replace(/_/g, " "))}</b></div>
      </div>
    </div>
    <div class="why">${escapeHtml(o.rationale || "")}</div>
  `;
  chat.appendChild(r); chat.scrollTop = chat.scrollHeight;
}

function tryReadout(text) {
  try {
    const m = text.trim().match(/\{[\s\S]*churn_risk_score[\s\S]*\}/);
    if (!m) return false;
    const o = JSON.parse(m[0]);
    if (typeof o.churn_risk_score !== "number") return false;
    vitalsReadout(o);
    return true;
  } catch (e) { return false; }
}

function fmtArgs(raw) {
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === "object" && !Array.isArray(p)) {
      return Object.entries(p).map(([k, v]) =>
        `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(typeof v === "string" ? v : JSON.stringify(v))}</div>`).join("");
    }
  } catch (e) {}
  return `<div class="v">${escapeHtml(raw)}</div>`;
}

function authCard(evt) {
  const chat = document.getElementById("chat");
  const a = document.createElement("div");
  a.className = "auth";
  a.innerHTML = `
    <div class="auth__head"><div class="seal">✎</div><div class="t">Authorize draft<small>for-signature · ${escapeHtml(evt.risk_level || "moderate")} risk</small></div></div>
    <div class="auth__body"><div class="kv">${fmtArgs(evt.arguments)}</div></div>
    <div class="auth__actions">
      <button type="button" class="ok">Authorize</button>
      <button type="button" class="no">Decline</button>
    </div>
  `;
  chat.appendChild(a); chat.scrollTop = chat.scrollHeight;
  const resolve = async (d) => {
    a.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const h = { "Content-Type": "application/json" };
      if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
      const res = await fetch(`${API_BASE}/v1/sessions/${sessionId}/approve`, {
        method: "POST", headers: h, body: JSON.stringify({ approval_id: evt.approval_id, decision: d, scope: "once" }),
      });
      const b = await res.json();
      a.querySelector(".t small").textContent = b.resolved ? `${d === "approve" ? "authorized" : "declined"}` : "could not resolve";
    } catch (e) { a.querySelector(".t small").textContent = `error: ${e}`; }
  };
  a.querySelector(".ok").addEventListener("click", () => resolve("approve"));
  a.querySelector(".no").addEventListener("click", () => resolve("deny"));
}

const STREAM_TIMEOUT_MS = 90_000;

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
    onEvent({ type: "error", error: t ? "Signal lost — please retry." : String(err) }); return;
  }
  const sid = res.headers.get("X-Session-Id");
  if (sid) { sessionId = sid; document.getElementById("session-id").textContent = `signal ${sid.slice(0,8)}`; document.getElementById("conn-dot").classList.add("on"); }
  if (!res.ok || !res.body) { onEvent({ type: "error", error: `HTTP ${res.status}` }); return; }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const ln of parts) {
        if (!ln.startsWith("data: ") || ln.includes("[DONE]")) continue;
        try { onEvent(JSON.parse(ln.slice(6))); } catch (e) { console.warn("bad SSE", ln, e); }
      }
    }
  } catch (err) {
    const t = err.name === "TimeoutError" || err.name === "AbortError";
    onEvent({ type: "error", error: t ? "Signal lost — please retry." : String(err) });
  }
}

async function send(message) {
  msg("user", message);
  const think = thinking();
  let cleared = false; const clear = () => { if (!cleared) { cleared = true; think.remove(); } };
  let bubble = null, acc = "";
  try {
    await streamChat(message, (evt) => {
      clear();
      switch (evt.type) {
        case "text_delta":
          // hold the JSON until complete (mid-stream it's partial); show a quiet accumulator
          acc += evt.content;
          if (!bubble) bubble = msg("agent", "");
          if (!acc.trimStart().startsWith("{")) bubble.textContent = acc; // plain text -> show live
          else bubble.textContent = "compiling readout…";
          break;
        case "tool_call": msg("tool", `-> ${evt.tool_name}(${evt.arguments})`); break;
        case "tool_result": msg("tool", `<- ${evt.tool_name}: ${evt.result}`); break;
        case "pending_approval": authCard(evt); break;
        case "complete":
          if (bubble && acc.trimStart().startsWith("{")) {
            // replace the "compiling" bubble with a vitals readout (or fall back to text)
            if (tryReadout(acc)) bubble.closest(".m").remove();
            else bubble.textContent = acc;
          } else if (!bubble && evt.content) {
            if (!tryReadout(evt.content)) msg("agent", evt.content);
          }
          break;
        case "error": msg("error", `Error: ${evt.error || JSON.stringify(evt)}`); break;
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
  send(m).catch((err) => msg("error", `Error: ${err}`));
});

renderAccounts();
