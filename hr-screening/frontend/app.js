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

// job_ids we've already rendered at least once -- lets render() tag only
// genuinely new rows with the entrance animation instead of replaying it
// on every 4s poll tick.
const renderedIds = new Set();

// Signature of the last rendered table ("job_id:decision" joined in render order). render() skips
// the full innerHTML rebuild when this is unchanged, so steady-state 4s polls don't destroy and
// recreate rows/buttons — click targets stay stable between a snapshot and a click.
let lastRenderSig = "";

const RECOMMENDATION_META = {
  strong_match: { label: "Strong match", cls: "strong" },
  possible_match: { label: "Possible match", cls: "possible" },
  weak_match: { label: "Weak match", cls: "weak" },
};

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

// Purely decorative avatar initials derived from the resume_id, e.g.
// "R-001" -> "R01". Falls back to "?" for unknown/unparsed ids.
function avatarInitials(resumeId) {
  if (!resumeId || resumeId === "(unknown)") return "?";
  const letter = (resumeId.match(/[A-Za-z]+/) || [""])[0].slice(0, 1).toUpperCase();
  const digits = (resumeId.match(/\d+/) || [""])[0].slice(-2);
  return `${letter}${digits}` || "?";
}

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
    submitStatus.classList.remove("is-error");
    submitStatus.classList.add("is-ok");
    log(`submitted job ${body.job_id} for ${resumeId}`);
  } catch (err) {
    submitStatus.textContent = `error: ${err.message}`;
    submitStatus.classList.remove("is-ok");
    submitStatus.classList.add("is-error");
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

// Event delegation for the decision buttons. The old inline
// onclick="setDecision('${r.job_id}',...)" interpolated a server value into a
// JS-string attribute -- a job_id containing a quote would break out of the
// string and execute arbitrary JS in the page (a real XSS sink, same class as
// the real-estate finding). data-attributes are HTML-escaped at the sink and
// read via dataset, so no string interpolation into executable context.
resultsBody.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".decision-btn[data-job]");
  if (!btn) return;
  setDecision(btn.dataset.job, btn.dataset.decision);
});

function render() {
  const sorted = rows.size === 0 ? [] : [...rows.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  // Skip the rebuild when nothing changed since the last render. The table polls every 4s and a
  // full innerHTML rebuild each tick destroys/recreates every <tr> and button, so an in-flight
  // Approve/Pass click could land on a detached node. Logical state (incl. each row's decision)
  // lives in the `rows` Map, so re-rendering only on actual change keeps the DOM stable.
  const sig = sorted.map((r) => `${r.job_id}:${r.decision ?? ""}`).join("|");
  if (sig === lastRenderSig) return;
  lastRenderSig = sig;
  if (rows.size === 0) {
    resultsBody.innerHTML = `<tr class="empty-row"><td colspan="5">
      <div class="empty-state">
        <span class="glyph">Nothing scored yet</span>
        <p>Completed jobs will land here automatically — this table polls in the background.</p>
      </div>
    </td></tr>`;
    return;
  }
  resultsBody.innerHTML = sorted
    .map((r) => {
      const meta = r.recommendation ? RECOMMENDATION_META[r.recommendation] : null;
      const bandCls = meta ? meta.cls : "neutral";
      const badge = meta
        ? `<span class="badge badge-${bandCls}"><span class="badge-dot"></span>${meta.label}</span>`
        : `<span class="badge badge-neutral"><span class="badge-dot"></span>--</span>`;
      const hasScore = r.score !== null && r.score !== undefined && r.score !== "";
      const pct = hasScore ? Math.max(0, Math.min(100, Number(r.score) || 0)) : 0;
      const scoreCell = `<div class="score-cell">
        <span class="score-ring score-${bandCls}" style="--pct:${pct}"><span>${hasScore ? Math.round(pct) : "--"}</span></span>
      </div>`;
      const decision = r.decision
        ? `<span class="decision-chip decision-${r.decision}">${r.decision === "approve" ? "Approved for interview" : "Passed"}</span>`
        : `<div class="decision-actions">
             <button class="decision-btn approve" data-job="${escapeHtml(r.job_id)}" data-decision="approve">Approve</button>
             <button class="decision-btn pass" data-job="${escapeHtml(r.job_id)}" data-decision="pass">Pass</button>
           </div>`;
      const isNew = !renderedIds.has(r.job_id) ? " row-enter" : "";
      return `<tr class="result-row${isNew}">
        <td>
          <div class="candidate-cell">
            <span class="avatar">${escapeHtml(avatarInitials(r.resume_id))}</span>
            <span class="candidate-id">${escapeHtml(r.resume_id)}</span>
          </div>
        </td>
        <td>${scoreCell}</td>
        <td>${badge}</td>
        <td class="rationale"><span class="rationale-text">${escapeHtml(r.rationale)}</span></td>
        <td>${decision}</td>
      </tr>`;
    })
    .join("");
  sorted.forEach((r) => renderedIds.add(r.job_id));
}

// Expose for inline onclick handlers.
window.setDecision = setDecision;

submitBtn.addEventListener("click", submitJob);

pollCompletedJobs();
setInterval(pollCompletedJobs, POLL_INTERVAL_MS);
