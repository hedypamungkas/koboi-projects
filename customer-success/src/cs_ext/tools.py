"""cs_ext/tools.py -- account-health tools for the customer-success analyst.

- ``fetch_account_health``  -- raw signals (usage, support, sentiment) for an account
- ``score_churn_risk``      -- a deterministic 0-100 churn-risk score + contributing factors
- ``draft_outreach``        -- MODERATE: drafts outreach copy; pauses for CSM approval before saving
- ``flag_at_risk``          -- flags an account for the CSM (the handover path)

The structured *recommendation* (recommended_action) is the agent's terminal answer, which
``self_healing.self_consistency`` consensus-votes -- so the deterministic scoring lives in a
tool (``score_churn_risk``), and the judgment the CSM cares about is sampled + aggregated.
"""

from __future__ import annotations

import json
import os
import time

from koboi.tools.registry import tool
from koboi.types import RiskLevel

AT_RISK_LOG = os.environ.get("CS_AT_RISK_LOG", "/data/at_risk.log")
OUTREACH_DIR = os.environ.get("CS_OUTREACH_DIR", "/data/outreach")

# --- Mock account-health store (no real CRM behind this) ----------------------
# Three accounts chosen to span the risk spectrum.
_ACCOUNTS: dict[str, dict] = {
    "ACC-7701": {
        "account_id": "ACC-7701",
        "name": "Crestline Logistics",
        "csm": "Dana Pierce",
        "health": {
            "product_usage_30d": "stable",
            "active_users_trend": "+4%",
            "open_support_tickets": 1,
            "nps": 9,
            "sentiment": "positive",
            "renewal_in_days": 120,
        },
    },
    "ACC-7702": {
        "account_id": "ACC-7702",
        "name": "Bluepeak Media",
        "csm": "Dana Pierce",
        "health": {
            "product_usage_30d": "declining",
            "active_users_trend": "-18%",
            "open_support_tickets": 6,
            "nps": 5,
            "sentiment": "frustrated",
            "renewal_in_days": 38,
        },
    },
    "ACC-7703": {
        "account_id": "ACC-7703",
        "name": "Northgate Health",
        "csm": "Sam Okafor",
        "health": {
            "product_usage_30d": "flat",
            "active_users_trend": "-2%",
            "open_support_tickets": 2,
            "nps": 7,
            "sentiment": "neutral",
            "renewal_in_days": 75,
        },
    },
}


def _account_or_error(account_id: str) -> tuple[dict | None, str | None]:
    acc = _ACCOUNTS.get(account_id)
    if acc is None:
        return None, f"Error: account {account_id!r} not found. Known demo accounts: {sorted(_ACCOUNTS)}."
    return acc, None


@tool(
    name="fetch_account_health",
    description="Fetch the raw health signals (usage, support, sentiment, renewal) for an account.",
    parameters={
        "type": "object",
        "properties": {"account_id": {"type": "string", "description": "Account id, e.g. ACC-7702"}},
        "required": ["account_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def fetch_account_health(account_id: str) -> str:
    acc, err = _account_or_error(account_id)
    if err:
        return err
    return json.dumps(acc)


@tool(
    name="score_churn_risk",
    description=(
        "Compute a deterministic 0-100 churn-risk score and the contributing factors for an "
        "account. Use the result as the basis for your risk assessment."
    ),
    parameters={
        "type": "object",
        "properties": {"account_id": {"type": "string", "description": "Account id, e.g. ACC-7702"}},
        "required": ["account_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def score_churn_risk(account_id: str) -> str:
    acc, err = _account_or_error(account_id)
    if err:
        return err
    h = acc["health"]

    score = 10
    factors: list[str] = []
    if h["product_usage_30d"] == "declining":
        score += 30
        factors.append("product usage declining")
    elif h["product_usage_30d"] == "flat":
        score += 8
        factors.append("flat product usage")
    trend = h["active_users_trend"]
    # trend_pct preserves the sign ("-18%" -> -18), so for a declining trend the
    # magnitude is -trend_pct. The previous `trend_pct >= 10` was unreachable for
    # ANY "-" trend (startswtith("-") => trend_pct <= 0, never >= 10), making the
    # +20 "major decline" branch dead code -- P1 bug C.
    trend_pct = int(trend.rstrip("%+-")) if trend.lstrip("+-").rstrip("%").isdigit() else 0
    if trend.startswith("-") and (-trend_pct) >= 10:
        score += 20
        factors.append(f"active users down {trend}")
    elif trend.startswith("-"):
        score += 6
    if h["open_support_tickets"] >= 5:
        score += 15
        factors.append(f"{h['open_support_tickets']} open support tickets")
    elif h["open_support_tickets"] >= 3:
        score += 7
    if h["nps"] <= 6:
        score += 10
        factors.append(f"NPS {h['nps']}")
    if h["sentiment"] in ("frustrated", "negative"):
        score += 10
        factors.append(f"{h['sentiment']} sentiment")
    if h["renewal_in_days"] <= 60 and score >= 40:
        factors.append(f"renewal in {h['renewal_in_days']}d -- act before it's due")

    score = max(0, min(100, score))
    level = "high" if score >= 55 else "medium" if score >= 30 else "low"
    return json.dumps({"account_id": account_id, "churn_risk_score": score, "risk_level": level, "factors": factors})


@tool(
    name="draft_outreach",
    description=(
        "Draft outreach copy (email / message) to an account in the customer's voice. PAUSES for "
        "CSM approval before the draft is saved -- sending customer-facing copy is human-gated."
    ),
    parameters={
        "type": "object",
        "properties": {
            "account_id": {"type": "string", "description": "Account id, e.g. ACC-7702"},
            "channel": {"type": "string", "description": "Channel, e.g. email, slack, linkedin"},
            "key_points": {"type": "string", "description": "The 1-3 points the outreach should make"},
        },
        "required": ["account_id", "channel", "key_points"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def draft_outreach(account_id: str, channel: str, key_points: str) -> str:
    acc, err = _account_or_error(account_id)
    if err:
        return err
    os.makedirs(OUTREACH_DIR, exist_ok=True)
    draft = {
        "ts": time.time(),
        "account_id": account_id,
        "account_name": acc["name"],
        "channel": channel,
        "key_points": key_points,
        "status": "approved-draft-saved",  # only written after the CSM approves the pause
    }
    path = os.path.join(OUTREACH_DIR, f"{account_id}-{int(time.time())}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(draft, f, indent=2)
    return f"Outreach draft for {acc['name']} ({channel}) saved -> {path}. (mock -- nothing is sent.)"


@tool(
    name="flag_at_risk",
    description=(
        "Flag an account as at-risk so the CSM gets a warm hand-off with a summary. Use for "
        "accounts that need human attention now; do not use for routine check-ins."
    ),
    parameters={
        "type": "object",
        "properties": {
            "account_id": {"type": "string", "description": "Account id, e.g. ACC-7702"},
            "reason": {"type": "string", "description": "Why this account is at-risk and needs the CSM now"},
        },
        "required": ["account_id", "reason"],
    },
    risk_level=RiskLevel.SAFE,
)
async def flag_at_risk(account_id: str, reason: str) -> str:
    acc, err = _account_or_error(account_id)
    if err:
        return err
    # Collapse whitespace so an LLM-controlled reason with embedded newlines can't
    # forge extra lines in the CSM's at-risk log (same log-injection class as
    # healthcare's flag_urgent_escalation).
    safe_reason = " ".join(str(reason).split())[:500]
    os.makedirs(os.path.dirname(AT_RISK_LOG) or ".", exist_ok=True)
    with open(AT_RISK_LOG, "a", encoding="utf-8") as f:
        f.write(f"{account_id} ({acc['name']}) | csm={acc['csm']} | {safe_reason}\n")
    return f"Flagged {acc['name']} ({account_id}) at-risk for {acc['csm']} with a warm hand-off summary."
