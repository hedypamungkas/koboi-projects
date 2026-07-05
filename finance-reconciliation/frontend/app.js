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

// Minimal HTML escaping for values interpolated into innerHTML templates below
// (defense in depth -- FLAGGED_INVOICES is static/trusted, but SSE-sourced
// tool_name/risk_level/arguments in addApprovalCard() are not).
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function renderInvoiceList() {
  const el = document.getElementById("invoice-list");
  el.innerHTML = "";
  for (const inv of FLAGGED_INVOICES) {
    const card = document.createElement("div");
    card.className = "invoice-card";
    card.dataset.status = inv.status;
    card.innerHTML = `
      <div class="invoice-card__top">
        <span class="invoice-id">${escapeHtml(inv.id)}</span>
        <span class="status-pill status-pill--${escapeHtml(inv.status)}"><span class="dot"></span>${escapeHtml(inv.status)}</span>
      </div>
      <div class="invoice-card__vendor">${escapeHtml(inv.vendor)}</div>
      <div class="invoice-card__meta">
        <span class="po-ref">${escapeHtml(inv.po)}</span>
        <span class="amount">$${inv.amount.toFixed(2)}</span>
      </div>
    `;
    card.addEventListener("click", () => {
      const input = document.getElementById("message");
      input.value = `Run a three-way match on invoice ${inv.id} against PO ${inv.po}`;
      input.focus();
    });
    el.appendChild(card);
  }
}

// Derived purely from FLAGGED_INVOICES -- no fabricated fields, just a quick
// scan strip so the controller doesn't have to count cards herself.
function renderInvoiceSummary() {
  const el = document.getElementById("invoice-summary");
  if (!el) return;
  const total = FLAGGED_INVOICES.length;
  const needsReview = FLAGGED_INVOICES.filter((inv) => inv.status === "flagged").length;
  const totalValue = FLAGGED_INVOICES.reduce((sum, inv) => sum + inv.amount, 0);
  el.innerHTML = `
    <div class="stat">
      <span class="stat-value">${total}</span>
      <span class="stat-label">In Queue</span>
    </div>
    <div class="stat">
      <span class="stat-value stat-value--amber">${needsReview}</span>
      <span class="stat-label">Needs Review</span>
    </div>
    <div class="stat">
      <span class="stat-value">$${totalValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
      <span class="stat-label">Total Value</span>
    </div>
  `;
}

const ROLE_LABELS = { user: "You", agent: "Agent", tool: "System", error: "Error" };

function addMessage(role, text) {
  const chat = document.getElementById("chat");
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = ROLE_LABELS[role] || role;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  // Cosmetic direction hint only (arrow prefixes are already part of the
  // existing tool_call/tool_result text) -- doesn't affect what's displayed.
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

// Lightweight "agent is working" placeholder shown between sending a message
// and the first SSE event. Purely cosmetic -- callers remove it themselves.
function addThinkingIndicator() {
  const chat = document.getElementById("chat");
  const wrap = document.createElement("div");
  wrap.className = "msg agent thinking";
  wrap.innerHTML = `
    <div class="msg-label">Agent</div>
    <div class="bubble">
      <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
    </div>
  `;
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

// evt.arguments is always the raw JSON string koboi accumulated from the
// tool-call stream (see koboi/events.py's ToolCallEvent/PendingApprovalEvent).
// Render it as a readable key/value grid when it parses as a JSON object;
// fall back to the original <pre> dump otherwise -- never lose information.
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
  } catch (e) {
    // not JSON -- fall through to the raw-text rendering below
  }
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
        <div class="title">Approval needed: ${escapeHtml(evt.tool_name)}</div>
        <span class="risk-pill risk-pill--${risk}">${escapeHtml(evt.risk_level)} risk</span>
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

  // Cosmetic-only: show a typing indicator until the first SSE event lands,
  // then clear it. Wrapped in try/finally so it never lingers on error.
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

renderInvoiceList();
renderInvoiceSummary();
