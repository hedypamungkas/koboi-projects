// Kessler & Vance contract-review workspace -- plain JS, no framework, no build step.
//
// Talks directly to the koboi server's /v1/chat/stream (SSE) endpoint. This demo config sets
// server.auth_required: false, so no Authorization header is sent -- in production that would be
// `Authorization: Bearer <token>` on every call (see docs/00-consuming-koboi-server.md §4).

const AUTH_REQUIRED = false; // mirrors config/agent.yaml server.auth_required
const API_KEY = ""; // would come from a login/config step if AUTH_REQUIRED were true

// The web container (nginx, static files only) and the koboi container are separate origins in
// docker-compose.yml (localhost:3005 vs localhost:8005), so calls go cross-origin -- that's why
// config/agent.yaml sets server.cors.allow_origins: ["*"]. In production you'd put both behind
// one reverse-proxy host and this could be a relative path instead.
const API_BASE = "http://localhost:8005";

const clauseInput = document.getElementById("clause-input");
const reviewForm = document.getElementById("review-form");
const reviewOutput = document.getElementById("review-output");
const flagBanner = document.getElementById("flag-banner");
const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const approvalsList = document.getElementById("approvals-list");

// Purely cosmetic elements added for the letterhead redesign -- optional chaining below means
// none of this throws if a future markup pass ever removes them.
const sessionBadge = document.getElementById("session-badge");
const sessionBadgeText = document.getElementById("session-badge-text");
const clauseCharCount = document.getElementById("clause-charcount");

let sessionId = null; // set from the X-Session-Id response header on the first turn

function authHeaders() {
  return AUTH_REQUIRED ? { Authorization: `Bearer ${API_KEY}` } : {};
}

// Cosmetic only -- reflects the already-established sessionId in the letterhead badge so the
// lawyer can see the review panel and the chat panel are sharing one session/memory. Does not
// change how sessionId itself is set or used in any request.
function updateSessionBadge(sid) {
  if (!sessionBadge || !sessionBadgeText) return;
  sessionBadge.classList.add("is-active");
  sessionBadgeText.textContent = `Session ${sid.slice(0, 8)}`;
}

if (clauseInput && clauseCharCount) {
  clauseInput.addEventListener("input", () => {
    const n = clauseInput.value.length;
    clauseCharCount.textContent = `${n} character${n === 1 ? "" : "s"}`;
  });
}

// Shared streaming helper -- fetch + ReadableStream against /v1/chat/stream, per
// docs/00-consuming-koboi-server.md §3. Reports the server-assigned session id (X-Session-Id
// response header) back to the caller once known, so the clause review and the follow-up chat
// share one session/memory.
// Bounds how long a single turn can stay open. Without this, a stalled/hung
// connection (rare, but observed once against the LLM gateway during testing --
// see koboi-use-cases-llm-gateway-empty-completions memory) leaves the review
// panel or chat stuck on "Thinking..." forever with no way for the lawyer to
// recover.
const STREAM_TIMEOUT_MS = 90_000;

async function streamChat(message, onEvent, onSessionId) {
  const headers = { "Content-Type": "application/json", ...authHeaders() };
  if (sessionId) headers["X-Session-Id"] = sessionId;

  let res;
  try {
    res = await fetch(`${API_BASE}/v1/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error("The review agent took too long to respond -- please try again.");
    }
    throw err;
  }

  const sid = res.headers.get("X-Session-Id");
  if (sid && onSessionId) onSessionId(sid);

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`chat stream failed: ${res.status} ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
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
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error("The review agent took too long to respond -- please try again.");
    }
    throw err;
  }
}

function addBubble(kind, text) {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function humanizeTool(toolName) {
  const map = {
    propose_redline: "drafting a redline",
    flag_novel_clause: "flagging this for a lawyer",
    memory_recall: "our notes",
    memory_store: "our notes",
  };
  return map[toolName] || toolName;
}

// propose_redline is RiskLevel.MODERATE, and koboi's server-side approval handler pauses for a
// human on MODERATE and DESTRUCTIVE tools alike (only SAFE auto-approves) -- see
// koboi/guardrails/approval.py:AsyncCallbackApprovalHandler. That's a good fit here: a lawyer
// approving the draft before it's returned is the "a lawyer reviews everything" safety property
// doc 05 describes, just enforced one step earlier than the doc's text implies.
function renderApprovalCard(approval) {
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.approvalId = approval.approvalId;

  // Eyebrow + summary line replace the old single <span> label -- purely a DOM/CSS restructure
  // for the letterhead redesign, still just descriptive text built from approval.summary.
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Pending — awaiting signature";
  card.appendChild(eyebrow);

  const label = document.createElement("span");
  label.className = "summary";
  label.textContent = approval.summary;
  card.appendChild(label);

  const buttons = document.createElement("div");
  buttons.className = "buttons";

  const approveBtn = document.createElement("button");
  approveBtn.className = "approve";
  approveBtn.textContent = "Approve";
  approveBtn.onclick = () => resolveApproval(approval, "approve", card);

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "reject";
  rejectBtn.textContent = "Decline";
  rejectBtn.onclick = () => resolveApproval(approval, "deny", card);

  buttons.appendChild(approveBtn);
  buttons.appendChild(rejectBtn);
  card.appendChild(buttons);

  approvalsList.appendChild(card);
}

// Cosmetic only -- shows a brief ink-stamp confirmation ("Approved"/"Declined") before the card
// leaves the DOM, instead of removing it instantly. The decision has already been accepted by the
// server by the time this runs; this just makes the moment of resolution legible.
function stampCard(card, decision) {
  const stamp = document.createElement("div");
  stamp.className = `approval-stamp ${decision === "approve" ? "is-approve" : "is-deny"}`;
  stamp.textContent = decision === "approve" ? "Approved" : "Declined";
  card.appendChild(stamp);
  card.classList.add("is-resolved");
  setTimeout(() => card.remove(), 900);
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
    stampCard(card, decision);
  } catch (err) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    addBubble("error", `Could not resolve approval: ${err.message}`);
  }
}

// Shared pending_approval handling for all three entry points below (review, discuss-in-chat,
// free chat) -- summarizes the redline draft so a lawyer can approve/reject it before koboi
// returns the tool's result to the model.
function handlePendingApproval(event) {
  let args = {};
  try {
    args = JSON.parse(event.arguments || "{}");
  } catch {
    /* leave args empty if malformed */
  }
  const summary =
    event.tool_name === "propose_redline"
      ? `Redline draft for ${args.clause_type || "clause"} -- approve to show it to the lawyer`
      : `${event.tool_name} -- approve to proceed`;
  renderApprovalCard({ sessionId, approvalId: event.approval_id, summary });
}

// "Review" button: paste a clause, get a redline/flag against the playbook -- doc 05's primary
// flow. Result is rendered into the review panel, not the chat log, so it reads like a work
// product rather than a chat message.
async function reviewClause(clauseText) {
  reviewOutput.textContent = "Reviewing against the playbook...";
  reviewOutput.classList.remove("has-redline"); // cosmetic reset of the maroon changebar accent
  flagBanner.hidden = true;
  flagBanner.textContent = "";
  let content = "";

  try {
    await streamChat(
      `Review this clause: ${clauseText}`,
      (event) => {
        switch (event.type) {
          case "tool_call":
            reviewOutput.textContent = `${content}\n\n[${humanizeTool(event.tool_name)}...]`;
            if (event.tool_name === "propose_redline") {
              reviewOutput.classList.add("has-redline"); // cosmetic changebar accent
            }
            if (event.tool_name === "flag_novel_clause") {
              flagBanner.hidden = false;
              flagBanner.textContent = "No playbook match -- flagged for lawyer review.";
            }
            break;
          case "pending_approval":
            reviewOutput.textContent = `${content}\n\n[waiting for approval below before the draft is shown]`;
            handlePendingApproval(event);
            break;
          case "text_delta":
            content += event.content;
            reviewOutput.textContent = content;
            break;
          case "complete":
            reviewOutput.textContent = content || "(no response text -- check tool_call output above)";
            enableRedlineActions();
            break;
          case "error":
            reviewOutput.textContent = `Something went wrong: ${event.error || "unknown error"}`;
            break;
          default:
            break;
        }
      },
      (sid) => {
        sessionId = sid;
        updateSessionBadge(sid);
      }
    );
  } catch (err) {
    reviewOutput.textContent = `Could not reach the review agent: ${err.message}`;
  }
}

function enableRedlineActions() {
  // Placeholder for wiring "accept redline" / "copy to clipboard" actions once a real
  // clause-management backend exists -- this demo only drafts text inside the session.
}

// Chat panel below the review output, per doc 05's "askAboutClause" pattern: the lawyer can keep
// talking through a flagged clause without retyping it.
function askAboutClause(text) {
  addBubble("user", `About this clause: "${text}"`);
  const statusBubble = addBubble("status", "Thinking...");
  let agentBubble = null;

  streamChat(
    `Review this clause against the playbook: ${text}`,
    (event) => {
      switch (event.type) {
        case "tool_call":
          statusBubble.textContent = `${humanizeTool(event.tool_name)}...`;
          if (event.tool_name === "flag_novel_clause") {
            addBubble("status", "No playbook match -- flagged for review");
          }
          break;
        case "pending_approval":
          if (statusBubble.isConnected) statusBubble.textContent = "Waiting for approval below...";
          handlePendingApproval(event);
          break;
        case "text_delta":
          if (statusBubble.isConnected) statusBubble.remove();
          if (!agentBubble) agentBubble = addBubble("agent", "");
          agentBubble.textContent += event.content;
          break;
        case "complete":
          if (statusBubble.isConnected) statusBubble.remove();
          // The model occasionally returns a completion with no text and no tool
          // call (confirmed gateway nondeterminism, not an app bug -- see
          // koboi-use-cases-llm-gateway-empty-completions memory).
          if (!agentBubble) addBubble("agent", "Sorry, I didn't get a response there -- try asking again.");
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
      updateSessionBadge(sid);
    }
  ).catch((err) => {
    statusBubble.remove();
    addBubble("error", `Could not reach the review agent: ${err.message}`);
  });
}

async function sendChatMessage(message) {
  addBubble("user", message);
  const statusBubble = addBubble("status", "Thinking...");
  let agentBubble = null;

  try {
    await streamChat(
      message,
      (event) => {
        switch (event.type) {
          case "tool_call":
            statusBubble.textContent = `${humanizeTool(event.tool_name)}...`;
            if (event.tool_name === "flag_novel_clause") {
              addBubble("status", "No playbook match -- flagged for review");
            }
            break;
          case "pending_approval":
            if (statusBubble.isConnected) statusBubble.textContent = "Waiting for approval below...";
            handlePendingApproval(event);
            break;
          case "text_delta":
            if (statusBubble.isConnected) statusBubble.remove();
            if (!agentBubble) agentBubble = addBubble("agent", "");
            agentBubble.textContent += event.content;
            chatLog.scrollTop = chatLog.scrollHeight;
            break;
          case "complete":
            if (statusBubble.isConnected) statusBubble.remove();
            // The model occasionally returns a completion with no text and no tool
            // call (confirmed gateway nondeterminism, not an app bug -- see
            // koboi-use-cases-llm-gateway-empty-completions memory).
            if (!agentBubble) addBubble("agent", "Sorry, I didn't get a response there -- try asking again.");
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
        updateSessionBadge(sid);
      }
    );
  } catch (err) {
    statusBubble.remove();
    addBubble("error", `Could not reach the review agent: ${err.message}`);
  }
}

reviewForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const clauseText = clauseInput.value.trim();
  if (!clauseText) return;
  // keep the pasted clause handy for the "discuss in chat" shortcut below
  window.__lastClauseText = clauseText;
  reviewClause(clauseText);
});

document.getElementById("discuss-clause").addEventListener("click", () => {
  const text = window.__lastClauseText || clauseInput.value.trim();
  if (!text) return;
  askAboutClause(text);
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = "";
  chatInput.disabled = true;
  sendChatMessage(message).finally(() => {
    chatInput.disabled = false;
    chatInput.focus();
  });
});
