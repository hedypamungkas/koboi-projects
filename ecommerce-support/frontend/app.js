// Anvil & Co support widget -- plain JS, no framework, no build step.
//
// Talks directly to the koboi server's /v1/chat/stream (SSE) and
// /v1/sessions/{id}/approve endpoints. This demo config sets
// server.auth_required: false, so no Authorization header is sent -- in
// production that would be `Authorization: Bearer <token>` on every call
// (see docs/00-consuming-koboi-server.md §4).

const AUTH_REQUIRED = false; // mirrors config/agent.yaml server.auth_required
const API_KEY = ""; // would come from a login/config step if AUTH_REQUIRED were true

// The web container (nginx, static files only) and the koboi container are
// separate origins in docker-compose.yml (localhost:3001 vs localhost:8001),
// so calls go cross-origin -- that's why config/agent.yaml sets
// server.cors.allow_origins: ["*"]. In production you'd put both behind one
// reverse-proxy host and this could be a relative path instead.
const API_BASE = "http://localhost:8001";

const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const approvalsList = document.getElementById("approvals-list");

let sessionId = null; // set from the X-Session-Id response header on first turn

function addBubble(kind, text) {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.textContent = text;
  // Cosmetic only -- a data attribute survives later `textContent +=` updates
  // (unlike child nodes would), so streamed agent bubbles can still show a
  // timestamp via CSS `content: attr(data-time)` without touching the text.
  el.dataset.time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function authHeaders() {
  return AUTH_REQUIRED ? { Authorization: `Bearer ${API_KEY}` } : {};
}

// Shared streaming helper -- fetch + ReadableStream against /v1/chat/stream,
// per docs/00-consuming-koboi-server.md §3. Reports the server-assigned
// session id (X-Session-Id header) back to the caller once known.
async function streamChat(message, onEvent, onSessionId) {
  const headers = { "Content-Type": "application/json", ...authHeaders() };
  if (sessionId) headers["X-Session-Id"] = sessionId;

  const res = await fetch(`${API_BASE}/v1/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message }),
  });

  const sid = res.headers.get("X-Session-Id");
  if (sid && onSessionId) onSessionId(sid);

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`chat stream failed: ${res.status} ${text}`);
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
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload.trim() === "[DONE]") continue;
      try {
        onEvent(JSON.parse(payload));
      } catch (err) {
        console.error("Failed to parse SSE event", err, payload);
      }
    }
  }
}

// Parses sendMessage()'s summary string ("Refund $12.34 -- order 10234
// (damaged in transit)") into parts for a nicer ticket layout. Purely a
// display concern -- if the format ever changes, parsed stays null and
// renderApprovalCard falls back to showing the raw summary untouched.
function parseApprovalSummary(summary) {
  const m = /^Refund \$([\d.,]+) -- order (\S+) \((.+)\)$/.exec(summary || "");
  if (!m) return null;
  // orderId may already carry a leading '#' (the model often passes "#10234");
  // strip it here so the single '#' the template adds back doesn't become '##'.
  return { amount: m[1], orderId: m[2].replace(/^#/, ""), reason: m[3] };
}

function renderApprovalCard(approval) {
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.approvalId = approval.approvalId;

  const parsed = parseApprovalSummary(approval.summary);

  if (parsed) {
    const top = document.createElement("div");
    top.className = "ticket-top";

    const tag = document.createElement("span");
    tag.className = "ticket-tag";
    tag.textContent = "Refund request";
    top.appendChild(tag);

    const order = document.createElement("span");
    order.className = "ticket-order";
    order.textContent = `#${parsed.orderId}`;
    top.appendChild(order);

    card.appendChild(top);

    const amount = document.createElement("div");
    amount.className = "ticket-amount";
    amount.textContent = `$${parsed.amount}`;
    card.appendChild(amount);

    const reason = document.createElement("p");
    reason.className = "ticket-reason";
    reason.textContent = parsed.reason;
    card.appendChild(reason);
  } else {
    const label = document.createElement("span");
    label.textContent = approval.summary;
    card.appendChild(label);
  }

  const buttons = document.createElement("div");
  buttons.className = "buttons";

  const approveBtn = document.createElement("button");
  approveBtn.className = "approve";
  approveBtn.textContent = "Approve";
  approveBtn.onclick = () => resolveApproval(approval, "approve", card);

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "reject";
  rejectBtn.textContent = "Reject";
  rejectBtn.onclick = () => resolveApproval(approval, "deny", card);

  buttons.appendChild(approveBtn);
  buttons.appendChild(rejectBtn);
  card.appendChild(buttons);

  approvalsList.appendChild(card);
}

async function resolveApproval(approval, decision, card) {
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    const res = await fetch(`${API_BASE}/v1/sessions/${approval.sessionId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ approval_id: approval.approvalId, decision }),
    });
    if (!res.ok) throw new Error(`approve failed: ${res.status}`);
    card.remove();
    addBubble(
      "status",
      decision === "approve"
        ? "Refund approved by support -- processing now."
        : "Refund rejected by support."
    );
  } catch (err) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    addBubble("error", `Could not resolve approval: ${err.message}`);
  }
}

async function sendMessage(message) {
  addBubble("user", message);
  const statusBubble = addBubble("status", "Thinking...");
  let agentBubble = null;

  try {
    await streamChat(
      message,
      (event) => {
        switch (event.type) {
          case "tool_call":
            statusBubble.textContent = `Checking ${humanizeTool(event.tool_name)}...`;
            break;
          case "text_delta":
            statusBubble.remove();
            if (!agentBubble) agentBubble = addBubble("agent", "");
            agentBubble.textContent += event.content;
            chatLog.scrollTop = chatLog.scrollHeight;
            break;
          case "pending_approval": {
            if (statusBubble.isConnected) {
              statusBubble.textContent = "Your refund is being reviewed by our team.";
            } else {
              addBubble("status", "Your refund is being reviewed by our team.");
            }
            let args = {};
            try {
              args = JSON.parse(event.arguments || "{}");
            } catch {
              /* leave args empty if malformed */
            }
            renderApprovalCard({
              sessionId,
              approvalId: event.approval_id,
              summary: `Refund $${Number(args.amount || 0).toFixed(2)} -- order ${
                args.order_id || "unknown"
              } (${args.reason || "no reason given"})`,
            });
            break;
          }
          case "complete":
            if (statusBubble.isConnected) statusBubble.remove();
            break;
          case "error":
            statusBubble.remove();
            addBubble("error", `Something went wrong: ${event.error || "unknown error"}`);
            break;
          default:
            break;
        }
      },
      (sid) => {
        sessionId = sid;
      }
    );
  } catch (err) {
    statusBubble.remove();
    addBubble("error", `Could not reach the support agent: ${err.message}`);
  }
}

function humanizeTool(toolName) {
  const map = {
    lookup_order: "your order",
    check_return_eligibility: "return eligibility",
    initiate_refund: "your refund",
    memory_recall: "our notes",
    memory_store: "our notes",
  };
  return map[toolName] || toolName;
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = "";
  chatInput.disabled = true;
  sendMessage(message).finally(() => {
    chatInput.disabled = false;
    chatInput.focus();
  });
});

// Cosmetic: land the cursor in the chat box on load, matching a real
// storefront widget that greets you ready to type.
chatInput.focus();
