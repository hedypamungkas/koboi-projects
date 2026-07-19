"""real-estate: drafts persist durably to a (locked) JSONL file, not the old
in-memory module-level dicts that raced under max_concurrent + delegate_tasks
and were lost on restart (P1 bug F)."""
from __future__ import annotations

import asyncio
import json


def test_draft_listing_persists_to_file(tmp_path):
    import realestate_ext.tools as re
    re.DRAFTS_LOG_PATH = str(tmp_path / "drafts.jsonl")
    asyncio.run(re.draft_listing_description("P-101"))
    recs = [json.loads(l) for l in (tmp_path / "drafts.jsonl").read_text().splitlines() if l.strip()]
    assert len(recs) == 1
    assert recs[0]["kind"] == "listing" and recs[0]["key"] == "P-101"
    assert "Harbor" in recs[0]["draft"] or "P-101" in recs[0]["draft"]


def test_concurrent_drafts_all_persist(tmp_path):
    import realestate_ext.tools as re
    re.DRAFTS_LOG_PATH = str(tmp_path / "drafts.jsonl")

    async def race():
        await asyncio.gather(
            re.draft_listing_description("P-101"),
            re.draft_listing_description("P-102"),
            re.draft_followup_email("L-001"),
            re.draft_followup_email("L-002"),
        )

    asyncio.run(race())
    recs = [json.loads(l) for l in (tmp_path / "drafts.jsonl").read_text().splitlines() if l.strip()]
    assert len(recs) == 4, f"concurrent drafts lost: {len(recs)}/4"


def test_frontend_escapes_job_content():
    """The XSS fix: app.js defines escapeHtml and wraps the LLM content sink."""
    from conftest import REPO_ROOT
    src = (REPO_ROOT / "real-estate/frontend/app.js").read_text()
    assert "function escapeHtml" in src, "escapeHtml helper missing"
    # The highest-risk sink (LLM-generated job content) must be escaped.
    assert "${escapeHtml(content)}" in src, "job content not escaped at the innerHTML sink"
