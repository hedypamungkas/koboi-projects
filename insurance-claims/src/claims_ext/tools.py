"""claims_ext/tools.py -- the four specialist tools for the triage DAG.

Each maps to one DAG node's job (config/agent.yaml ``orchestration.agents``):

- ``lookup_claim``      -> coverage_check reads the claim record
- ``estimate_repair_cost`` -> damage_estimate prices the repair from the loss description
- ``screen_fraud``      -> fraud_screen scores the claim against fraud indicators
- ``record_recommendation`` -> decide writes a settlement recommendation an adjuster acts on

None of these move money or touch a real claims system -- this is a runnable POC backed by
a small in-memory claim store. ``transfer_to_human`` (the human-routing path) is a koboi
builtin, not defined here.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time

from koboi.tools.registry import tool
from koboi.types import RiskLevel

RECOMMENDATIONS_PATH = os.environ.get("CLAIMS_RECOMMENDATIONS_LOG", "/data/recommendations.jsonl")

# --- Mock claim store (no real claims system behind this) ---------------------
# A handful of FNOL records chosen to exercise each triage outcome:
#   CLM-501 -- minor collision, covered, low value, low fraud       -> recommend
#   CLM-502 -- vehicle total loss, covered, high value              -> total loss -> handover
#                                                                  (policy denies auto-recommend)
#   CLM-503 -- late-reported, prior damage present                  -> elevated fraud -> handover
#   CLM-504 -- comprehensive windshield claim, low value, low fraud -> recommend
_CLAIMS: dict[str, dict] = {
    "CLM-501": {
        "claim_id": "CLM-501",
        "policyholder": "A. Rivera",
        "policy": "BM-AUTO-22071",
        "loss_type": "rear-end collision at low speed",
        "damage_description": "Rear bumper cracked, one tail light shattered, trunk lid misaligned.",
        "reported_within": "24 hours",
        "prior_damage": False,
        "value_hint": "low",
    },
    "CLM-502": {
        "claim_id": "CLM-502",
        "policyholder": "M. Okafor",
        "policy": "BM-AUTO-22071",
        "loss_type": "single-vehicle collision with guardrail",
        "damage_description": "Front end destroyed, frame buckled, airbags deployed -- vehicle is a total loss.",
        "reported_within": "6 hours",
        "prior_damage": False,
        "value_hint": "high",
    },
    "CLM-503": {
        "claim_id": "CLM-503",
        "policyholder": "T. Lindqvist",
        "policy": "BM-AUTO-44190",
        "loss_type": "hit while parked, no third party",
        "damage_description": "Driver-side door dented and scraped; side mirror snapped off.",
        "reported_within": "19 days",  # late reporting -- a fraud indicator
        "prior_damage": True,          # pre-existing damage -- another indicator
        "value_hint": "medium",
    },
    "CLM-504": {
        "claim_id": "CLM-504",
        "policyholder": "S. Chen",
        "policy": "BM-AUTO-22071",
        "loss_type": "road debris cracked windshield",
        "damage_description": "Windshield cracked across the driver field of view; no other damage.",
        "reported_within": "2 hours",
        "prior_damage": False,
        "value_hint": "low",
    },
}


def _claim_or_error(claim_id: str) -> tuple[dict | None, str | None]:
    claim = _CLAIMS.get(claim_id)
    if claim is None:
        return None, f"Error: claim {claim_id!r} not found. Known demo claims: {sorted(_CLAIMS)}."
    return claim, None


@tool(
    name="lookup_claim",
    description="Look up a first-notice-of-loss claim record by claim id (e.g. CLM-501).",
    parameters={
        "type": "object",
        "properties": {"claim_id": {"type": "string", "description": "Claim id, e.g. CLM-501"}},
        "required": ["claim_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def lookup_claim(claim_id: str) -> str:
    claim, err = _claim_or_error(claim_id)
    if err:
        return err
    return json.dumps(claim)


@tool(
    name="estimate_repair_cost",
    description=(
        "Estimate the repair cost (USD) from a free-text damage description. Returns a "
        "stable ballpark figure plus a confidence note -- not a body-shop quote."
    ),
    parameters={
        "type": "object",
        "properties": {
            "damage_description": {"type": "string", "description": "Free-text description of the damage"},
        },
        "required": ["damage_description"],
    },
    risk_level=RiskLevel.SAFE,
)
async def estimate_repair_cost(damage_description: str) -> str:
    text = (damage_description or "").strip().lower()
    # Deterministic pseudo-estimate from the description so the same damage yields the same
    # number (the self_healing CRITIC re-checks arithmetic via `calculate`, so stability
    # matters more than realism here). Scale by severity cues in the text.
    h = int(hashlib.sha256(text.encode()).hexdigest()[:8], 16)
    base = 250 + (h % 1750)  # $250-$2000 baseline
    if "total loss" in text or "frame buckled" in text or "destroyed" in text:
        estimate = 9_500 + (h % 6_000)  # total-loss band
        note = "total-loss band -- confirm ACV with the adjuster"
    elif "windshield" in text:
        estimate = 350 + (h % 250)
        note = "glass-only repair"
    elif "door" in text or "mirror" in text:
        estimate = 600 + (h % 900)
        note = "panel + trim repair"
    else:
        estimate = base
        note = "standard body repair"
    return json.dumps({"estimate_usd": estimate, "confidence": note})


@tool(
    name="screen_fraud",
    description=(
        "Screen a claim for fraud indicators by claim id. Returns a risk level "
        "(low / medium / high) and the indicators present."
    ),
    parameters={
        "type": "object",
        "properties": {"claim_id": {"type": "string", "description": "Claim id, e.g. CLM-501"}},
        "required": ["claim_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def screen_fraud(claim_id: str) -> str:
    claim, err = _claim_or_error(claim_id)
    if err:
        return err

    indicators: list[str] = []
    # `or ""` (not just a .get default) so a present-but-None value can't make
    # `"day" in None` / `"".lower()` raise -- robust to data changes.
    rw = claim.get("reported_within") or ""
    if "day" in rw:  # "19 days" etc. -- reported well after the loss
        indicators.append("late reporting (>72h)")
    if claim.get("prior_damage"):
        indicators.append("pre-existing damage noted")
    # Single-vehicle / hit-while-parked losses with no independent witness are routinely
    # flagged for review -- represent that without inventing facts about the policyholder.
    loss_type = (claim.get("loss_type") or "").lower()
    if "no third party" in loss_type or "single-vehicle" in loss_type:
        indicators.append("no independent witness / third party")

    if len(indicators) >= 2:
        risk = "high"
    elif indicators:
        risk = "medium"
    else:
        risk = "low"
    return json.dumps({"fraud_risk": risk, "indicators": indicators})


@tool(
    name="record_recommendation",
    description=(
        "Record a settlement recommendation for a claim that an adjuster will act on "
        "downstream. This does NOT pay the claim -- it only queues a suggestion in the "
        "adjuster review queue, so it runs without a pause. Use only for simple, low-value, "
        "clearly-covered, low-fraud claims; route anything else to transfer_to_human."
    ),
    parameters={
        "type": "object",
        "properties": {
            "claim_id": {"type": "string", "description": "Claim id, e.g. CLM-501"},
            "amount": {"type": "number", "description": "Recommended settlement amount (USD)"},
            "rationale": {
                "type": "string",
                "description": "One-line rationale citing the coverage basis and value basis",
            },
        },
        "required": ["claim_id", "amount", "rationale"],
    },
    risk_level=RiskLevel.SAFE,
)
async def record_recommendation(claim_id: str, amount: float, rationale: str) -> str:
    # Defense-in-depth for the policy.rules "*total loss*" deny: that glob is
    # case-sensitive in koboi 0.18.x, so "Total Loss"/"TOTAL LOSS" would bypass
    # it. A total-loss claim must never get an auto-recommendation, so enforce
    # it here too, case-insensitively (P1 bug D).
    if "total loss" in (rationale or "").lower():
        return (
            "Cannot auto-recommend on a total-loss claim -- route to a human "
            "adjuster via transfer_to_human. (rationale indicates total loss.)"
        )
    # Validate amount: NaN/Inf would make json.dumps emit invalid JSON
    # (NaN/Infinity tokens) that breaks the adjuster dashboard's strict parser.
    if (not isinstance(amount, (int, float))) or isinstance(amount, bool) \
            or not math.isfinite(amount) or amount < 0:
        return f"Error: amount must be a finite non-negative number (USD), got {amount!r}."
    os.makedirs(os.path.dirname(RECOMMENDATIONS_PATH) or ".", exist_ok=True)
    row = {
        "ts": time.time(),
        "claim_id": claim_id,
        "amount": amount,
        "rationale": rationale,
    }
    with open(RECOMMENDATIONS_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")
    return (
        f"Recorded settlement recommendation for {claim_id}: ${amount:,.2f} -- "
        f"queued for adjuster review. (mock -- no payment issued.)"
    )
