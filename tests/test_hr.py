"""hr-screening tool tests: concurrency safety, input validation, corrupt-file
quarantine (the proven data-loss cascade, bug #3)."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile

import pytest


def _hr(tmp):
    import hr_ext.tools as hr
    hr.REVIEW_QUEUE_PATH = os.path.join(tmp, "review_queue.json")
    return hr


def test_concurrent_scores_keep_all_records(tmp_path):
    hr = _hr(str(tmp_path))

    async def race():
        await asyncio.gather(*[
            hr.score_candidate(rid, s, "r", rec)
            for rid, s, rec in [("R-001", 80, "strong_match"), ("R-002", 30, "weak_match"),
                                ("R-003", 60, "possible_match"), ("R-004", 90, "strong_match"),
                                ("R-001", 75, "possible_match")]
        ])

    asyncio.run(race())
    q = json.loads((tmp_path / "review_queue.json").read_text())
    assert len(q) == 5, f"concurrent writes lost records: only {len(q)}/5 persisted"


@pytest.mark.parametrize("bad_score,rec,label", [
    (150, "strong_match", "above range"),
    (-5, "strong_match", "below range"),
    (float("nan"), "strong_match", "NaN"),
    (float("inf"), "strong_match", "Inf"),
    (50, "bogus", "bad recommendation enum"),
])
def test_invalid_inputs_rejected(tmp_path, bad_score, rec, label):
    hr = _hr(str(tmp_path))
    out = asyncio.run(hr.score_candidate("R-001", bad_score, "r", rec))
    assert out.startswith("Error:"), f"{label}: should be rejected, got {out!r}"


def test_corrupt_file_quarantined_not_wiped(tmp_path):
    hr = _hr(str(tmp_path))
    # Pre-corrupt the queue file (simulates a truncated write from a crash/race).
    (tmp_path / "review_queue.json").write_text("{not valid json")
    asyncio.run(hr.score_candidate("R-001", 88, "r", "strong_match"))
    # New entry recorded...
    q = json.loads((tmp_path / "review_queue.json").read_text())
    assert len(q) == 1
    # ...and the corrupt file was sidecared, not silently discarded.
    assert any(p.name.startswith("review_queue.json.corrupt") for p in tmp_path.iterdir())


def test_audit_hook_handles_malformed_tool_arguments():
    """ScoringAuditHook must not crash/drop on malformed LLM JSON (P2 robustness)."""
    import json as _json
    from types import SimpleNamespace
    from hr_ext.hooks import ScoringAuditHook

    async def run(raw):
        ctx = SimpleNamespace(
            tool_name="score_candidate",
            tool_arguments=raw,
            tool_result="ok",
        )
        hk = ScoringAuditHook()
        # execute() writes to AUDIT_LOG_PATH under /data -- point it at a temp dir.
        import hr_ext.hooks as h
        h.AUDIT_LOG_PATH = os.path.join(tempfile.mkdtemp(), "audit.jsonl")
        return await hk.execute(ctx)

    # Malformed JSON -> hook records a _raw entry, does not raise.
    asyncio.run(run("{not json"))
    # No tool_arguments -> still no raise.
    asyncio.run(run(None))
