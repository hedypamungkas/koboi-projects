// app.js -- The Competitive Brief (salmon broadsheet UI). Vanilla JS, talks to koboi's
// deep_research /v1/chat/stream + /v1/jobs (SSE). See docs/00 §3.

const API_BASE = window.KOBOI_API_BASE || (window.location.port === "3008" ? `${window.location.protocol}//${window.location.hostname}:8008` : "");
const API_KEY = window.KOBOI_API_KEY || "";

let sessionId = null;

const WATCHLIST = {
  primary: ["Acme Cloud", "Brightline Ops", "Coreway Systems"],
  focus: ["pricing", "launches", "earnings", "people", "regulatory"],
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

// Minimal markdown -> article HTML (headings, paragraphs, bullets, [n] citations).
function mdBrief(text) {
  const esc = escapeHtml(text);
  const cited = esc.replace(/\[(\d+)\]/g, "<sup>[$1]</sup>");
  const lines = cited.split("\n");
  let html = "", inList = false, para = [];
  const flush = () => {
    if (para.length) { html += `<p>${para.join(" ")}</p>`; para = []; }
  };
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) { if (inList) { html += "</ul>"; inList = false; } flush(); continue; }
    if (/^#{1,3}\s+/.test(t)) { if (inList) { html += "</ul>"; inList = false; } flush(); html += `<h3>${t.replace(/^#{1,3}\s+/, "")}</h3>`; continue; }
    if (/^[-*]\s+/.test(t)) { flush(); if (!inList) { html += "<ul>"; inList = true; } html += `<li>${t.replace(/^[-*]\s+/, "")}</li>`; continue; }
    para.push(t);
  }
  if (inList) html += "</ul>";
  flush();
  return html;
}

function renderChips() {
  const prim = document.getElementById("chips-primary");
  prim.innerHTML = "";
  WATCHLIST.primary.forEach((name, i) => {
    const el = document.createElement("span");
    el.className = "docket-item";
    el.innerHTML = `<span class="num">${String(i + 1).padStart(2, "0")}</span>${escapeHtml(name)}`;
    el.addEventListener("click", () => { const m = document.getElementById("message"); m.value = `Research ${name} this quarter.`; m.focus(); });
    prim.appendChild(el);
  });
  const foc = document.getElementById("chips-focus");
  foc.innerHTML = "";
  WATCHLIST.focus.forEach((t) => {
    const el = document.createElement("span");
    el.className = "tag";
    el.textContent = t;
    el.addEventListener("click", () => { const m = document.getElementById("message"); m.value = `Summarize what changed this quarter in ${t}.`; m.focus(); });
    foc.appendChild(el);
  });
}

const ROLE = { user: "The Desk Asks", agent: "Northwind Analyst", tool: "Filed by Research Engine", error: "Correction" };

function addEntry(role, text) {
  const chat = document.getElementById("chat");
  const item = document.createElement("div");
  item.className = `item ${role}`;
  const byline = document.createElement("div");
  byline.className = "byline";
  byline.textContent = ROLE[role] || role;
  const copy = document.createElement("div");
  copy.className = "copy";
  if (role === "tool") {
    if (text.startsWith("->")) { copy.classList.add("call"); text = text.replace(/^->\s*/, ""); }
    else if (text.startsWith("<-")) { copy.classList.add("result"); text = text.replace(/^<-\s*/, ""); }
  }
  copy.textContent = text;
  item.appendChild(byline);
  item.appendChild(copy);
  chat.appendChild(item);
  chat.scrollTop = chat.scrollHeight;
  return copy;
}

function addThinking() {
  const chat = document.getElementById("chat");
  const item = document.createElement("div");
  item.className = "item agent thinking";
  item.innerHTML = `<div class="byline">${ROLE.agent}</div><div class="copy"><span class="d">·</span><span class="d">·</span><span class="d">·</span> working sources</div>`;
  chat.appendChild(item);
  chat.scrollTop = chat.scrollHeight;
  return item;
}

// Must be >= llm.timeout (300s in config/agent.yaml) + headroom: a live-chat
// deep_research can legitimately run several minutes, and the previous 240s
// value cut the client off while the backend was still working (timeout
// inversion). For long weekly briefs, prefer the async "Dispatch weekly brief"
// button (POST /v1/jobs), which uses jobs.timeout_seconds (1800s).
const STREAM_TIMEOUT_MS = 330_000;

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
    onEvent({ type: "error", error: t ? "Research timed out — narrow the scope." : String(err) });
    return;
  }
  const sid = res.headers.get("X-Session-Id");
  if (sid) { sessionId = sid; document.getElementById("session-id").textContent = `brief #${sid.slice(0,8)}`; document.getElementById("conn-dot").classList.add("on"); }
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
    onEvent({ type: "error", error: t ? "Research timed out — narrow the scope." : String(err) });
  }
}

async function send(message) {
  addEntry("user", message);
  const think = addThinking();
  let cleared = false; const clear = () => { if (!cleared) { cleared = true; think.remove(); } };
  let bubble = null, acc = "";
  try {
    await streamChat(message, (evt) => {
      clear();
      switch (evt.type) {
        case "text_delta":
          if (!bubble) { bubble = addEntry("agent", ""); bubble.classList.add("article"); }
          acc += evt.content; bubble.innerHTML = mdBrief(acc);
          document.getElementById("chat").scrollTop = 1e9;
          break;
        case "tool_call": addEntry("tool", `-> ${evt.tool_name}(${evt.arguments})`); break;
        case "tool_result": addEntry("tool", `<- ${evt.tool_name}: ${evt.result}`); break;
        case "complete":
          if (!bubble && evt.content) { const b = addEntry("agent", ""); b.classList.add("article"); b.innerHTML = mdBrief(evt.content); }
          break;
        case "error": addEntry("error", `Error: ${evt.error || JSON.stringify(evt)}`); break;
        default: console.log("event", evt);
      }
    });
  } finally { clear(); }
}

async function runWeeklyBrief() {
  const btn = document.getElementById("run-brief");
  btn.disabled = true; btn.textContent = "Dispatching…";
  addEntry("user", "Dispatch this week's competitive brief (autonomous job).");
  const think = addThinking();
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  let bubble = null, acc = "";
  try {
    const submit = await fetch(`${API_BASE}/v1/jobs`, {
      method: "POST", headers,
      body: JSON.stringify({ message: "Run this week's competitive brief across all tracked competitors; cite every claim.", mode: "act" }),
    });
    if (!submit.ok) { think.remove(); addEntry("error", `Job submit failed: HTTP ${submit.status}`); return; }
    const { job_id } = await submit.json();
    addEntry("tool", `-> dispatched job ${job_id}`);
    const sr = await fetch(`${API_BASE}/v1/jobs/${job_id}/stream`, { headers: { ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) }, signal: AbortSignal.timeout(STREAM_TIMEOUT_MS) });
    if (sr.ok && sr.body) {
      const reader = sr.body.getReader(); const dec = new TextDecoder(); let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop();
        for (const ln of parts) {
          if (!ln.startsWith("data: ") || ln.includes("[DONE]")) continue;
          try {
            const evt = JSON.parse(ln.slice(6)); think.remove();
            if (evt.type === "text_delta") { if (!bubble) { bubble = addEntry("agent", ""); bubble.classList.add("article"); } acc += evt.content; bubble.innerHTML = mdBrief(acc); document.getElementById("chat").scrollTop = 1e9; }
            else if (evt.type === "complete" && evt.content && !bubble) { const b = addEntry("agent", ""); b.classList.add("article"); b.innerHTML = mdBrief(evt.content); }
            else if (evt.type === "error") addEntry("error", `Error: ${evt.error}`);
            else console.log("event", evt);
          } catch (e) { console.warn("bad SSE", e); }
        }
      }
    } else { think.remove(); addEntry("tool", `<- job ${job_id} submitted; poll GET /v1/jobs/${job_id}`); }
  } catch (err) {
    think.remove();
    const t = err.name === "TimeoutError" || err.name === "AbortError";
    addEntry("error", t ? "Brief job timed out — it may still be running; check /v1/jobs." : String(err));
  } finally { btn.disabled = false; btn.textContent = "Dispatch weekly brief"; }
}

document.getElementById("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("message");
  const m = input.value.trim();
  if (!m) return;
  input.value = "";
  send(m).catch((err) => addEntry("error", `Error: ${err}`));
});
document.getElementById("run-brief").addEventListener("click", () => runWeeklyBrief());

renderChips();
