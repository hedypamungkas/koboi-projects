"""customer-success: the churn-risk sign bug (P1 bug C). A major decline
(-18%) must out-score a minor one (-2%) -- the +20 branch was dead code."""
from __future__ import annotations

import asyncio
import json
import os

import pytest


def _cs():
    import cs_ext.tools as cs
    return cs


def _score(cs, trend):
    h = {"product_usage_30d": "declining", "active_users_trend": trend,
         "open_support_tickets": 0, "nps": 10, "sentiment": "neutral", "renewal_in_days": 365}
    cs._ACCOUNTS = {"T": {"account_id": "T", "name": "T", "health": h, "tier": "mid",
                          "renewal_date": "", "arr": 1, "owner": "", "csm": "csm"}}
    return json.loads(asyncio.run(cs.score_churn_risk("T")))


def test_major_decline_outscores_minor_decline():
    cs = _cs()
    major = _score(cs, "-18%")["churn_risk_score"]
    minor = _score(cs, "-2%")["churn_risk_score"]
    assert major > minor, f"major decline ({major}) should out-score minor ({minor})"


def test_decline_factor_present_for_major_decline():
    cs = _cs()
    factors = _score(cs, "-25%")["factors"]
    assert any("active users down" in f for f in factors), f"major-decline factor missing: {factors}"


def test_growth_not_flagged_as_decline():
    cs = _cs()
    factors = _score(cs, "+5%")["factors"]
    assert not any("active users down" in f for f in factors)


def test_flag_at_risk_sanitizes_reason_newlines(tmp_path):
    """flag_at_risk must not let an LLM-controlled reason forge extra log lines."""
    import cs_ext.tools as cs
    cs.AT_RISK_LOG = str(tmp_path / "atrisk.log")
    cs._ACCOUNTS = {"A": {"account_id": "A", "name": "Acme", "health": {}, "csm": "Pat"}}
    asyncio.run(cs.flag_at_risk("A", "churn\nEVIL: forged line\tinject"))
    lines = (tmp_path / "atrisk.log").read_text().splitlines()
    assert len(lines) == 1, f"reason newlines not collapsed: {lines}"
