// app.js -- Ledgerline controller dashboard: mock flagged-invoice panel + chat
// wired to koboi's /v1/chat/stream (SSE), per docs/00-consuming-koboi-server.md Sec.3.

// koboi is published on localhost:8003 by docker-compose.yml (backend maps 8003->8000).
// Override by setting `window.KOBOI_API_BASE` before this script loads, e.g. via a
// small inline <script> tag, if you deploy behind a different host/port.
const API_BASE = window.KOBOI_API_BASE || "http://localhost:8003";

// This POC runs with server.auth_required: false (see README), so no bearer token
// is required. If you flip that on, set API_KEY here and it will be sent along.
const API_KEY = window.KOBOI_API_KEY || "";

let sessionId = null;

// Mock data mirroring erp_mcp_server.py's in-memory sample invoices -- the
// "nightly job" that would normally populate this panel via /v1/jobs isn't
// wired up in this demo, so the flagged list here is static.
const FLAGGED_INVOICES = [
  { id: "INV-8842", vendor: "Alden Fasteners Co.", po: "PO-4471", amount: 4200.0, status: "matched" },
  { id: "INV-9013", vendor: "Brightline Steel", po: "PO-5502", amount: 12800.0, status: "matched" },
  { id: "INV-9104", vendor: "Coreway Machining", po: "PO-5610", amount: 990.0, status: "flagged" },
];

function renderInvoiceList() {
  const el = document.getElementById("invoice-list");
  el.innerHTML = "";
  for (const inv of FLAGGED_INVOICES) {
    const card = document.createElement("div");
    card.className = "invoice-card";
    card.innerHTML = `
      <div class="row">
        <strong>${inv.id}</strong>
        <span class="badge ${inv.status}">${inv.status}</span>
      </div>
      <div class="vendor">${inv.vendor} &middot; ${inv.po} &middot; $${inv.amount.toFixed(2)}</div>
    `;
    card.addEventListener("click", () => {
      const input = document.getElementById("message");
      input.value = `Run a three-way match on invoice ${inv.id} against PO ${inv.po}`;
      input.focus();
    });
    el.appendChild(card);
  }
}

function addMessage(role, text) {
  const chat = document.getElementById("chat");
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

function addApprovalCard(evt) {
  const chat = document.getElementById("chat");
  const card = document.createElement("div");
  card.className = "approval-card";
  card.innerHTML = `
    <div class="title">Approval needed: ${evt.tool_name} (${evt.risk_level})</div>
    <pre>${evt.arguments}</pre>
    <button class="approve-btn">Approve</button>
    <button class="reject-btn">Reject</button>
  `;
  chat.appendChild(card);
  chat.scrollTop = chat.scrollHeight;

  const resolve = async (decision) => {
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const headers = { "Content-Type": "application/json" };
      if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
      const res = await fetch(`${API_BASE}/v1/sessions/${sessionId}/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ approval_id: evt.approval_id, decision, scope: "once" }),
      });
      const body = await res.json();
      card.querySelector(".title").textContent += body.resolved
        ? ` -- ${decision}d`
        : " -- failed to resolve";
    } catch (err) {
      card.querySelector(".title").textContent += ` -- error: ${err}`;
    }
  };

  card.querySelector(".approve-btn").addEventListener("click", () => resolve("approve"));
  card.querySelector(".reject-btn").addEventListener("click", () => resolve("deny"));
}

// Shared streamChat() pattern from doc 00 Sec.3, extended to carry X-Session-Id
// across turns (so "post that entry" lands in the same session as the match).
//
// mode is pinned to "act" on every request. koboi's CHAT-mode tool gate
// (koboi/hooks/mode_hook.py's ModeHook) only recognizes a hardcoded set of
// koboi's own builtin tool names as "read-only" (read/search/grep/.../
// calculator) -- it has no idea our MCP tools (fetch_invoice,
// fetch_purchase_order, three_way_match) are read-only, so it blocks them
// outright in CHAT mode with "tool 'X' is not allowed. Switch to ACT or
// AUTO mode". ACT mode allows all tools by name, and -- separately and
// unaffected by mode -- post_journal_entry's RiskLevel.DESTRUCTIVE still
// triggers the approval pause (mode and the approval gate are orthogonal
// checks in koboi's tool pipeline; only YOLO mode skips approval). See
// README's "Deliberate deviations" section.
async function streamChat(message, onEvent) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  if (sessionId) headers["X-Session-Id"] = sessionId;

  const res = await fetch(`${API_BASE}/v1/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, mode: "act" }),
  });

  const newSid = res.headers.get("X-Session-Id");
  if (newSid) {
    sessionId = newSid;
    document.getElementById("session-id").textContent = `session: ${sessionId}`;
  }

  if (!res.ok || !res.body) {
    onEvent({ type: "error", error: `HTTP ${res.status}` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop(); // keep the last (possibly incomplete) chunk in the buffer
    for (const line of parts) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch (e) {
        console.warn("bad SSE frame", line, e);
      }
    }
  }
}

async function sendMessage(message) {
  addMessage("user", message);
  let agentBubble = null;

  await streamChat(message, (evt) => {
    switch (evt.type) {
      case "text_delta":
        if (!agentBubble) agentBubble = addMessage("agent", "");
        agentBubble.textContent += evt.content;
        break;
      case "tool_call":
        addMessage("tool", `-> calling ${evt.tool_name}(${evt.arguments})`);
        break;
      case "tool_result":
        addMessage("tool", `<- ${evt.tool_name} result: ${evt.result}`);
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
}

document.getElementById("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("message");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  sendMessage(message).catch((err) => addMessage("error", `Error: ${err}`));
});

renderInvoiceList();
