// Riverside Family Clinic -- pre-visit intake chat.
//
// Talks directly to the koboi server's /v1/chat/stream (see docs/00 §3 in the
// koboi-use-cases repo for the shared pattern). Two corrections vs. that doc's
// illustrative snippet, both verified against the actual server code:
//
//   1. Event field is `content`, not `text` -- koboi/events.py's TextDeltaEvent
//      has a `content` field, and event_to_dict() serializes dataclass fields
//      as-is (no rename to `text`).
//   2. Multi-turn conversations need the `X-Session-Id` response header echoed
//      back as a request header on the next call -- /v1/chat/stream is
//      per-request stateless otherwise (koboi/server/app.py mints a fresh
//      session per call when no X-Session-Id is supplied).
//
// auth_required is false in config/agent.yaml for this local demo (see
// README), so no Authorization header is sent. A production deployment would
// create a token via `koboi keys create` and send it as `Authorization: Bearer
// <token>`.

const API_BASE = window.KOBOI_API_BASE || "http://localhost:8004";

let sessionId = null;

// Bounds how long a single turn can stay open. Without this, a stalled/hung
// connection (rare, but observed once against the LLM gateway during testing --
// see koboi-use-cases-llm-gateway-empty-completions memory) leaves the patient
// staring at a pending bubble forever with no way to recover.
const STREAM_TIMEOUT_MS = 90_000;

async function streamChat(message, onEvent) {
  const headers = { "Content-Type": "application/json" };
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
      throw new Error("That took too long to answer -- please try again.");
    }
    throw err;
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body?.error?.message || detail;
    } catch {
      /* non-JSON error body, keep statusText */
    }
    throw new Error(`Request failed (${res.status}): ${detail}`);
  }

  const headerSid = res.headers.get("X-Session-Id");
  if (headerSid) sessionId = headerSid;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? ""; // keep the last, possibly-incomplete frame
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            onEvent(JSON.parse(payload));
          } catch {
            /* ignore malformed frame (e.g. SSE keepalive comment) */
          }
        }
      }
    }
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error("That took too long to answer -- please try again.");
    }
    throw err;
  }
}

const messagesEl = document.getElementById("messages");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const srStatus = document.getElementById("sr-status");

// Announces text to screen readers exactly once via the visually-hidden
// #sr-status live region -- used only for the final "complete"/"error"
// event, never per streamed token (see index.html's comment on #sr-status
// for why the visible #messages container isn't itself a live region).
function announce(text) {
  if (srStatus) srStatus.textContent = text;
}

function addBubble(role, text) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

addBubble("system", "Let's get you checked in. What's the main reason for today's visit?");

form.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  addBubble("patient", text);
  input.value = "";
  autoResizeTextarea();
  input.disabled = true;
  sendBtn.disabled = true;

  const assistantBubble = addBubble("assistant pending", "");

  try {
    await streamChat(text, (event) => {
      if (event.type === "text_delta") {
        assistantBubble.textContent += event.content;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else if (event.type === "complete") {
        // Final text after output guardrails have run (may include a
        // [GUARDRAIL WARNING ...] prefix -- see README). This is the
        // authoritative text; it can differ from what streamed live.
        // Falls back to a friendly prompt when the model returns nothing at all
        // (confirmed gateway nondeterminism, not an app bug -- see
        // koboi-use-cases-llm-gateway-empty-completions memory) so the patient
        // never sees a silently blank reply.
        const finalText = event.content || "Sorry, I didn't catch that -- could you say it again?";
        assistantBubble.textContent = finalText;
        assistantBubble.classList.remove("pending");
        announce(finalText);
      } else if (event.type === "error") {
        assistantBubble.remove();
        addBubble("error", `Something went wrong: ${event.error}`);
        announce(`Something went wrong: ${event.error}`);
      }
      // tool_call / tool_result (flag_urgent_escalation) intentionally have no
      // UI treatment -- the patient never sees "you've been flagged"; that's
      // for the clinician's side, not this chat.
    });
  } catch (err) {
    assistantBubble.remove();
    addBubble("error", `Something went wrong: ${err.message}`);
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }
});

input.addEventListener("keydown", (evt) => {
  if (evt.key === "Enter" && !evt.shiftKey) {
    evt.preventDefault();
    form.requestSubmit();
  }
});

// Purely cosmetic: grow the textarea as the patient types (capped by the
// max-height set in index.html's CSS), so short answers don't feel cramped
// and longer ones don't force a scrollbar too soon. Doesn't touch the
// streaming/session logic above.
function autoResizeTextarea() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}
input.addEventListener("input", autoResizeTextarea);
