"""insurance-claims: the policy.rules case-sensitive bypass (P1 bug D) is
defended in-tool, and bad amounts are rejected (P2: NaN/Inf -> invalid JSON)."""
from __future__ import annotations

import asyncio
import json

import pytest


def _cl(tmp_path):
    import claims_ext.tools as cl
    cl.RECOMMENDATIONS_PATH = str(tmp_path / "rec.jsonl")
    return cl


def test_routine_recommendation_recorded(tmp_path):
    cl = _cl(tmp_path)
    out = asyncio.run(cl.record_recommendation("CLM-501", 1200.0, "Covered collision, repair basis."))
    assert "Recorded" in out
    recs = [json.loads(l) for l in (tmp_path / "rec.jsonl").read_text().splitlines()]
    assert recs[0]["amount"] == 1200.0


@pytest.mark.parametrize("rationale", ["Total Loss per adjuster", "TOTAL LOSS", "vehicle is a total loss"])
def test_total_loss_routed_to_human_regardless_of_case(tmp_path, rationale):
    cl = _cl(tmp_path)
    out = asyncio.run(cl.record_recommendation("CLM-9", 5000.0, rationale))
    assert "human" in out.lower(), f"case variant {rationale!r} bypassed the deny: {out!r}"
    # And nothing was recorded.
    assert not (tmp_path / "rec.jsonl").exists() or not (tmp_path / "rec.jsonl").read_text().strip()


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -100, "cheap"])
def test_bad_amount_rejected(tmp_path, bad):
    cl = _cl(tmp_path)
    out = asyncio.run(cl.record_recommendation("CLM-1", bad, "routine"))
    assert out.startswith("Error:"), f"bad amount {bad!r} should be rejected, got {out!r}"
