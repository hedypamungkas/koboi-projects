// app.js -- Northwind Service Concierge (warm portal UI). Vanilla JS, talks to the concierge
// koboi instance /v1/chat/stream (SSE). call_peer_agent fan-outs render as department route cards.

const API_BASE = window.KOBOI_API_BASE || (window.location.port === "3009" ? `${window.location.protocol}//${window.location.hostname}:8009` : "");
const API_KEY = window.KOBOI_API_KEY || "concierge-smoke-key-1234"; // A2A forces auth (see README)

let sessionId = null;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const peerDept = (name) => /facilit/i.test(name || "") ? "fac" : "it";
const peerLabel = (d) => d === "fac" ? "Facilities desk" : "IT desk";

// tiny markdown -> html (bold, headings, keep newlines)
function md(text) {
  let s = escapeHtml(text);
  s = s.replace(/^#{1,4}\s+(.*)$/gm, '<b class="h">$1</b>');
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return s;
}

function bubble(role, text) {
  const chat = document.getElementById("chat");
  const b = document.createElement("div");
  b.className = `b ${role}`;
  const lbl = document.createElement("div");
  lbl.className = "lbl";
  lbl.textContent = ({ user: "You", agent: "Concierge", tool: "Note", error: "Problem" })[role] || role;
  const x = document.createElement("div");
  x.className = "x";
  if (role === "tool") {
    if (text.startsWith("->")) text = text.replace(/^->\s*/, "");
    else if (text.startsWith("<-")) text = text.replace(/^<-\s*/, "");
  }
  x.textContent = text;
  b.appendChild(lbl); b.appendChild(x);
  chat.appendChild(b); chat.scrollTop = chat.scrollHeight;
  return x;
}

function thinking() {
  const chat = document.getElementById("chat");
  const b = document.createElement("div");
  b.className = "b agent thinking";
  b.innerHTML = `<div class="lbl">Concierge</div><div class="x"><span class="d">·</span><span class="d">·</span><span class="d">·</span> checking with the desk</div>`;
  chat.appendChild(b); chat.scrollTop = chat.scrollHeight;
  return b;
}

// A call_peer_agent call/result -> a department routing card.
function routeCard(kind, dept, text) {
  const chat = document.getElementById("chat");
  const r = document.createElement("div");
  r.className = `route ${dept}`;
  const head = kind === "call"
    ? `<span class="d"></span>Routing <span class="arrow">→</span> ${escapeHtml(peerLabel(dept))}`
    : `<span class="d"></span>${escapeHtml(peerLabel(dept))} replied <span class="arrow">←</span>`;
  r.innerHTML = `<div class="head">${head}</div><div class="body ${kind === "result" ? "answer" : ""}">${kind === "result" ? md(text) : escapeHtml(text)}</div>`;
  chat.appendChild(r); chat.scrollTop = chat.scrollHeight;
}

function extractPeerAndMessage(argsRaw) {
  try {
    const a = JSON.parse(argsRaw);
    const call = (a.calls && a.calls[0]) || {};
    return { dept: peerDept(call.peer), message: call.message || argsRaw };
  } catch (e) { return { dept: "it", message: argsRaw }; }
}
function extractAnswer(resultRaw) {
  // result like: "[IT] (OK)\nAnswer: <the answer>" -- show the Answer: part (or the whole thing).
  const m = String(resultRaw).split(/Answer:\s*/i);
  return m.length > 1 ? m.slice(1).join("Answer: ").trim() : String(resultRaw);
}

const STREAM_TIMEOUT_MS = 150_000;

async function streamChat(message, onEvent) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` };
  if (sessionId) headers["X-Session-Id"] = sessionId;
  let res;
  try {
    res = await fetch(`${API_BASE}/v1/chat/stream`, {
      method: "POST", headers, body: JSON.stringify({ message, mode: "act" }),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const t = err.name === "TimeoutError" || err.name === "AbortError";
    onEvent({ type: "error", error: t ? "Timed out — please retry." : String(err) }); return;
  }
  const sid = res.headers.get("X-Session-Id");
  if (sid) { sessionId = sid; document.getElementById("session-id").textContent = `session ${sid.slice(0,8)}`; document.getElementById("conn-dot").classList.add("on"); }
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
    onEvent({ type: "error", error: t ? "Timed out — please retry." : String(err) });
  }
}

async function send(message) {
  bubble("user", message);
  const think = thinking();
  let cleared = false; const clear = () => { if (!cleared) { cleared = true; think.remove(); } };
  let agentX = null;
  try {
    await streamChat(message, (evt) => {
      clear();
      switch (evt.type) {
        case "text_delta":
          if (!agentX) agentX = bubble("agent", "");
          agentX.textContent += evt.content;
          break;
        case "tool_call":
          if (evt.tool_name === "call_peer_agent") {
            const { dept, message: msg } = extractPeerAndMessage(evt.arguments);
            routeCard("call", dept, msg);
          } else if (evt.tool_name === "transfer_to_human") {
            bubble("tool", `→ handed to a human coordinator: ${evt.arguments}`);
          } else {
            bubble("tool", `-> ${evt.tool_name}(${evt.arguments})`);
          }
          break;
        case "tool_result":
          if (evt.tool_name === "call_peer_agent") {
            const ans = extractAnswer(evt.result);
            const dept = /^\[facilit/i.test(evt.result) ? "fac" : "it";
            routeCard("result", dept, ans);
          } else {
            bubble("tool", `<- ${evt.tool_name}: ${evt.result}`);
          }
          break;
        case "complete":
          if (!agentX && evt.content) bubble("agent", evt.content);
          break;
        case "error":
          bubble("error", `Error: ${evt.error || JSON.stringify(evt)}`); break;
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
  send(m).catch((err) => bubble("error", `Error: ${err}`));
});
document.querySelectorAll(".quick-wrap button[data-q]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("message").value = btn.dataset.q;
    document.getElementById("message").focus();
  });
});
