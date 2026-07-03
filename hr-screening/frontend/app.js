// Northstar Talent recruiter dashboard -- plain JS, no build step, no chat.
//
// Per docs/00-consuming-koboi-server.md SS2/SS3, this is a *jobs* app: submit
// one job per resume (POST /v1/jobs), then poll for completed jobs instead of
// following a live SSE conversation.
//
// One real-API wrinkle worth calling out (see hr-screening/README.md
// "Deviations from spec"): `GET /v1/jobs?status=completed` (verified against
// the installed koboi.server.app `list_jobs` route) returns only
// `{job_id, status, session_id}` -- no `result` payload inline, unlike the
// abbreviated pseudo-code in docs/02. So this dashboard does a second fetch,
// `GET /v1/jobs/{job_id}`, per completed job to pull `result.content` (the
// agent's final message). The system prompt asks the model to make that final
// message a single JSON object ({resume_id, score, rationale, recommendation})
// so it can be parsed here instead of shown as raw prose.

// Dev default: dashboard served on :3002, koboi on :8002 (see docker-compose.yml).
// Anything else (e.g. reverse-proxied behind one origin in prod) falls back to
// same-origin relative requests.
const API_BASE = window.location.port === "3002" ? `${window.location.protocol}//${window.location.hostname}:8002` : "";
const POLL_INTERVAL_MS = 4000;

const resultsBody = document.getElementById("resultsBody");
const pollStatus = document.getElementById("pollStatus");
const submitBtn = document.getElementById("submitBtn");
const submitStatus = document.getElementById("submitStatus");
const resumeIdInput = document.getElementById("resumeId");
const logEl = document.getElementById("log");

// job_id -> { resume_id, score, rationale, recommendation, decision }
const rows = new Map();

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = `[${ts}] ${msg}\n` + logEl.textContent;
}

async function apiFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
}

async function submitJob() {
  const resumeId = resumeIdInput.value.trim();
  if (!resumeId) return;
  submitBtn.disabled = true;
  submitStatus.textContent = "submitting...";
  try {
    const res = await apiFetch("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({
        message: `Score resume ${resumeId} against the Senior Backend Engineer requisition`,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    submitStatus.textContent = `job ${body.job_id} submitted (${body.status})`;
    log(`submitted job ${body.job_id} for ${resumeId}`);
  } catch (err) {
    submitStatus.textContent = `error: ${err.message}`;
    log(`submit failed: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
}

function parseResultContent(content) {
  // Model is instructed to reply with a bare JSON object; fall back to raw
  // text (still shown, just not table-shaped) if it didn't comply.
  if (!content) return null;
  try {
    // Tolerate stray markdown fences some models still add.
    const cleaned = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { rationale: content, score: null, recommendation: null, resume_id: null };
  }
}

async function fetchJobDetail(jobId) {
  const res = await apiFetch(`/v1/jobs/${jobId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pollCompletedJobs() {
  try {
    const res = await apiFetch("/v1/jobs?status=completed");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const jobs = await res.json();
    pollStatus.textContent = `polling... (${jobs.length} completed)`;

    for (const job of jobs) {
      if (rows.has(job.job_id)) continue; // already fetched detail once
      const detail = await fetchJobDetail(job.job_id);
      const parsed = parseResultContent(detail.result && detail.result.content);
      rows.set(job.job_id, {
        job_id: job.job_id,
        resume_id: (parsed && parsed.resume_id) || "(unknown)",
        score: parsed ? parsed.score : null,
        rationale: parsed ? parsed.rationale : "(no result content)",
        recommendation: parsed ? parsed.recommendation : null,
        decision: null,
      });
    }
    render();
  } catch (err) {
    pollStatus.textContent = `polling error: ${err.message}`;
  }
}

function setDecision(jobId, decision) {
  const row = rows.get(jobId);
  if (!row) return;
  row.decision = decision;
  render();
}

function render() {
  if (rows.size === 0) {
    resultsBody.innerHTML = `<tr><td colspan="5" class="status">No completed jobs yet.</td></tr>`;
    return;
  }
  const sorted = [...rows.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  resultsBody.innerHTML = sorted
    .map((r) => {
      const badge = r.recommendation
        ? `<span class="badge ${r.recommendation}">${r.recommendation.replace("_", " ")}</span>`
        : "--";
      const decision = r.decision
        ? `<span class="decision">${r.decision === "approve" ? "Approved for interview" : "Passed"}</span>`
        : `<button class="secondary" onclick="setDecision('${r.job_id}','approve')">Approve for interview</button>
           <button class="secondary" onclick="setDecision('${r.job_id}','pass')">Pass</button>`;
      return `<tr>
        <td>${r.resume_id}</td>
        <td>${r.score ?? "--"}</td>
        <td>${badge}</td>
        <td class="rationale">${r.rationale}</td>
        <td>${decision}</td>
      </tr>`;
    })
    .join("");
}

// Expose for inline onclick handlers.
window.setDecision = setDecision;

submitBtn.addEventListener("click", submitJob);

pollCompletedJobs();
setInterval(pollCompletedJobs, POLL_INTERVAL_MS);
