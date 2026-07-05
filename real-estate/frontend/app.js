// Harbor Realty Group -- buyer chat widget + agent dashboard.
// Talks directly to the koboi server over HTTP/SSE (docs/00 #3). No build step, no framework.

const API_BASE = window.KOBOI_API_BASE || "http://localhost:8006";
// server.auth_required is false for this local POC (see config/agent.yaml) so this can stay
// empty; in production this would be a real Bearer token from `koboi keys create` (docs/00 #4).
const API_KEY = window.KOBOI_API_KEY || "";

// ---------------------------------------------------------------------------
// Shared streaming helper (docs/00 #3)
// ---------------------------------------------------------------------------
async function streamChat(message, onEvent) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const res = await fetch(`${API_BASE}/v1/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) {
    onEvent({ type: "error", message: `Request failed (${res.status})` });
    return;
  }
  // Needed so callers can act on session-scoped events (e.g. POST /approve for a
  // pending_approval event) without the server sending the session id in-band.
  const sessionId = res.headers.get("X-Session-Id");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop(); // keep the last (possibly incomplete) chunk in the buffer
    for (const line of chunks) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      try {
        onEvent(JSON.parse(line.slice(6)), sessionId);
      } catch (e) {
        // ignore malformed chunk
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabs = {
  chat: { btn: document.getElementById("tab-chat"), panel: document.getElementById("panel-chat") },
  dashboard: { btn: document.getElementById("tab-dashboard"), panel: document.getElementById("panel-dashboard") },
};

function activateTab(name) {
  for (const [key, t] of Object.entries(tabs)) {
    t.btn.classList.toggle("active", key === name);
    t.panel.classList.toggle("active", key === name);
  }
  // Design polish only: lets CSS retune the whole page (fonts/colors/radii) per
  // tab register -- consumer-warm for chat, operational for the dashboard.
  document.body.dataset.mode = name;
  if (name === "dashboard") refreshJobs();
}

tabs.chat.btn.addEventListener("click", () => activateTab("chat"));
tabs.dashboard.btn.addEventListener("click", () => activateTab("dashboard"));

// ---------------------------------------------------------------------------
// Buyer chat widget
// ---------------------------------------------------------------------------
const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const listingSelect = document.getElementById("listing-select");

function appendBubble(role, text) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function appendHint(text) {
  const el = document.createElement("div");
  el.className = "hint";
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

// Design polish: the listing dropdown's option text already carries an address
// and (for P-103) a "(rental)" hint -- this just mirrors that into a nicer
// preview card and doesn't change what streamChat sends. Purely additive/
// display-only; the submit handler below still reads listingSelect.value the
// same way it always did.
function updateListingPreview() {
  const preview = document.getElementById("listing-preview");
  const tagEl = document.getElementById("listing-tag");
  const addrEl = document.getElementById("listing-address");
  const idEl = document.getElementById("listing-id-label");
  if (!preview || !tagEl || !addrEl || !idEl) return;
  const opt = listingSelect.options[listingSelect.selectedIndex];
  if (!opt) return;
  const address = opt.dataset.address || "";
  const type = opt.dataset.type || "";
  if (!address) {
    preview.classList.add("is-general");
    tagEl.textContent = "No listing";
    addrEl.textContent = "General question";
    idEl.textContent = "";
  } else {
    preview.classList.remove("is-general");
    tagEl.textContent = type;
    addrEl.textContent = address;
    idEl.textContent = opt.value;
  }
}
listingSelect.addEventListener("change", updateListingPreview);
updateListingPreview();

// Design polish: quick-question chips just prefill the input and submit
// through the exact same #chat-form handler -- no new request path.
document.querySelectorAll(".chip[data-question]").forEach((chip) => {
  chip.addEventListener("click", () => {
    chatInput.value = chip.dataset.question;
    if (typeof chatForm.requestSubmit === "function") {
      chatForm.requestSubmit();
    } else {
      chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = chatInput.value.trim();
  if (!raw) return;
  chatInput.value = "";

  const listingId = listingSelect.value;
  const message = listingId ? `[listing:${listingId}] ${raw}` : raw;

  appendBubble("user", raw);
  const submitBtn = chatForm.querySelector("button");
  submitBtn.disabled = true;

  let hint = null;
  let redirected = false;
  const bubble = appendBubble("assistant", "");
  await streamChat(message, (event, sessionId) => {
    if (redirected) return; // already gave the buyer a final answer -- ignore the rest of the stream
    if (event.type === "text_delta") {
      // TextDeltaEvent's field is `content`, not `text` (koboi/events.py) -- fixed
      // a pre-existing typo here so the assistant bubble actually renders streamed
      // text (verified against the sibling apps' app.js, all of which use
      // event.content); the event type this branch handles is unchanged.
      bubble.textContent += event.content || "";
    } else if (event.type === "tool_call") {
      if (!hint) hint = appendHint("checking property details...");
    } else if (event.type === "pending_approval") {
      // draft_listing_description / draft_followup_email are MODERATE risk, so the
      // server pauses the tool call and waits for a human to approve/deny via
      // POST /v1/sessions/:id/approve. There's no approver in this buyer-facing
      // widget, so without this branch the buyer would stare at "checking property
      // details..." for the full timeout_seconds (120s) before the server
      // auto-denies it anyway. Deny it ourselves immediately and redirect the buyer
      // instead of making them wait.
      redirected = true;
      fetch(`${API_BASE}/v1/sessions/${sessionId}/approve`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ approval_id: event.approval_id, decision: "deny" }),
      }).catch(() => {}); // best-effort -- the server auto-denies on timeout regardless
      bubble.textContent =
        "Property descriptions and follow-ups are handled by our team, not live in this chat " +
        "-- happy to answer questions about this listing instead!";
    } else if (event.type === "error") {
      bubble.textContent = "Sorry, something went wrong -- try again shortly.";
    }
  });
  if (hint) hint.remove();
  submitBtn.disabled = false;
});

// ---------------------------------------------------------------------------
// Agent dashboard -- nightly batch of drafts awaiting review.
//
// koboi has no separate "list drafts" endpoint (drafts live wherever the CRM's
// draft field/pending-send queue does -- see src/realestate_ext/tools.py).
// This dashboard instead lists the job runs themselves via GET /v1/jobs and
// shows each job's final message, which is where the agent reports what it
// drafted. "Run nightly batch now" is a demo convenience for this POC --
// production triggers the same POST /v1/jobs from an external cron (docs/00).
// ---------------------------------------------------------------------------
function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

// Design polish: computes the four small counters above the job list from the
// same `jobs` array refreshJobs() already fetched -- no extra requests, no
// change to how jobs are listed or a detail is fetched. Guarded so this is a
// no-op if the stats markup isn't present.
function updateJobStats(jobs) {
  const totalEl = document.getElementById("stat-total");
  if (!totalEl) return;
  const counts = { pending: 0, running: 0, completed: 0, failed: 0 };
  for (const job of jobs) {
    if (Object.prototype.hasOwnProperty.call(counts, job.status)) counts[job.status] += 1;
  }
  totalEl.textContent = jobs.length;
  document.getElementById("stat-pending").textContent = counts.pending + counts.running;
  document.getElementById("stat-completed").textContent = counts.completed;
  document.getElementById("stat-failed").textContent = counts.failed;
}

async function refreshJobs() {
  const listEl = document.getElementById("job-list");
  listEl.innerHTML = '<p class="empty">Loading...</p>';
  try {
    const res = await fetch(`${API_BASE}/v1/jobs`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const jobs = await res.json();
    updateJobStats(jobs);
    if (!jobs.length) {
      listEl.innerHTML = '<p class="empty">No batch runs yet -- click "Run nightly batch now" to try one.</p>';
      return;
    }
    listEl.innerHTML = "";
    for (const job of jobs.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "job-row";
      row.innerHTML = `
        <div><strong>${job.job_id}</strong>
          <span class="status-pill status-${job.status}">${job.status}</span>
        </div>
        <div class="meta">session ${job.session_id}</div>
      `;
      row.addEventListener("click", () => showJobDetail(job.job_id));
      listEl.appendChild(row);
    }
  } catch (e) {
    listEl.innerHTML = `<p class="empty">Could not load jobs (${e.message}). Is the koboi server running?</p>`;
    updateJobStats([]);
  }
}

async function showJobDetail(jobId) {
  const card = document.getElementById("job-detail-card");
  const detail = document.getElementById("job-detail");
  card.style.display = "block";
  detail.innerHTML = "<p>Loading...</p>";
  try {
    const res = await fetch(`${API_BASE}/v1/jobs/${jobId}`, { headers: authHeaders() });
    const job = await res.json();
    const content = job.result && job.result.content ? job.result.content : null;
    detail.innerHTML = `
      <p class="meta">status: <span class="status-pill status-${job.status}">${job.status}</span> | session: ${job.session_id}</p>
      ${job.error ? `<pre class="draft">Error: ${job.error}</pre>` : ""}
      ${content ? `<pre class="draft">${content}</pre>` : "<p class=\"empty\">No result yet.</p>"}
    `;
  } catch (e) {
    detail.innerHTML = `<p class="empty">Could not load job ${jobId}.</p>`;
  }
}

document.getElementById("refresh-jobs-btn").addEventListener("click", refreshJobs);

document.getElementById("run-batch-btn").addEventListener("click", async () => {
  const btn = document.getElementById("run-batch-btn");
  btn.disabled = true;
  btn.textContent = "Starting...";
  try {
    const res = await fetch(`${API_BASE}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        message:
          "Draft listing descriptions for properties P-101, P-102, P-103, and P-104, and a " +
          "follow-up email for stale lead L-002.",
        mode: "act",
      }),
    });
    await res.json();
  } catch (e) {
    // surfaced via the job list refresh failing to find it
  } finally {
    btn.disabled = false;
    btn.textContent = "Run nightly batch now";
    refreshJobs();
  }
});

// Initial load
refreshJobs();
