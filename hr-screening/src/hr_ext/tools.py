"""hr_ext/tools -- fetch_resume + score_candidate.

No real ATS behind this demo: `_RESUMES` is a hardcoded in-memory sample set.
`score_candidate` is advisory-only -- it writes a recommendation to a review
queue file that a human recruiter reads later; it never rejects or advances a
candidate itself (see docs/02-hr-recruiting-screening.md).
"""

from __future__ import annotations

import json
import os
import time

from koboi.tools.registry import tool
from koboi.types import RiskLevel

# Where score_candidate persists its advisory recommendations. Mounted as a
# Docker volume (/data) so results survive container restarts.
REVIEW_QUEUE_PATH = os.environ.get("HR_REVIEW_QUEUE_PATH", "/data/review_queue.json")

# Sample resumes standing in for a real ATS lookup.
_RESUMES: dict[str, dict[str, str]] = {
    "R-001": {
        "name": "Amara Fitri",
        "summary": (
            "8 years backend engineering. Led a team building a Python/FastAPI payments "
            "platform processing 2M tx/day. Deep experience with PostgreSQL, Kafka, and "
            "AWS (EKS, RDS). Mentored 4 junior engineers. Previously at a fintech scale-up."
        ),
    },
    "R-002": {
        "name": "Bram Setiawan",
        "summary": (
            "2 years experience as a frontend developer using React and TypeScript. Built "
            "internal dashboards and marketing sites. No backend or distributed-systems "
            "experience. Comfortable with Git and basic CI/CD."
        ),
    },
    "R-003": {
        "name": "Chandra Wijaya",
        "summary": (
            "5 years backend engineering in Java and Go. Built microservices on Kubernetes "
            "for an e-commerce company, owns an internal service-mesh migration. Some "
            "Python scripting experience but no production Python backend work."
        ),
    },
    "R-004": {
        "name": "Dewi Anggraini",
        "summary": (
            "10 years engineering leadership, most recently as a VP of Engineering at a "
            "50-person startup. Strong systems-design background but has not written "
            "production code hands-on in the last 3 years."
        ),
    },
}


@tool(
    name="fetch_resume",
    description="Fetch a candidate's resume text and metadata by resume_id.",
    parameters={
        "type": "object",
        "properties": {"resume_id": {"type": "string"}},
        "required": ["resume_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def fetch_resume(resume_id: str) -> str:
    resume = _RESUMES.get(resume_id)
    if resume is None:
        return f"Error: no resume found for resume_id={resume_id!r}"
    metadata = {"resume_id": resume_id, "name": resume["name"]}
    return f"{json.dumps(metadata)}\n---\n{resume['summary']}"


@tool(
    name="score_candidate",
    description=(
        "Record a fit score + rationale for a candidate. Advisory only -- never "
        "rejects or advances a candidate; a human recruiter makes that call."
    ),
    parameters={
        "type": "object",
        "properties": {
            "resume_id": {"type": "string"},
            "score": {"type": "number", "description": "0-100 fit score"},
            "rationale": {"type": "string", "description": "why this score, citing job criteria"},
            "recommendation": {
                "type": "string",
                "enum": ["strong_match", "possible_match", "weak_match"],
            },
        },
        "required": ["resume_id", "score", "rationale", "recommendation"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def score_candidate(resume_id: str, score: float, rationale: str, recommendation: str) -> str:
    entry = {
        "resume_id": resume_id,
        "name": _RESUMES.get(resume_id, {}).get("name", "unknown"),
        "score": score,
        "rationale": rationale,
        "recommendation": recommendation,
        "scored_at": time.time(),
    }

    os.makedirs(os.path.dirname(REVIEW_QUEUE_PATH), exist_ok=True)
    queue: list[dict] = []
    if os.path.exists(REVIEW_QUEUE_PATH):
        try:
            with open(REVIEW_QUEUE_PATH) as f:
                queue = json.load(f)
        except (json.JSONDecodeError, OSError):
            queue = []
    queue.append(entry)
    with open(REVIEW_QUEUE_PATH, "w") as f:
        json.dump(queue, f, indent=2)

    return f"Recorded score={score} for {resume_id} (recommendation={recommendation})"
