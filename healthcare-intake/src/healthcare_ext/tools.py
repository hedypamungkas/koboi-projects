"""healthcare_ext/tools.py -- flag_urgent_escalation, the only tool this app exposes.

Deliberately the only tool: no EHR write, no filesystem/shell access, nothing that
could act on a patient's record. This appends one line to a review queue a human
(a nurse) is already watching -- it cannot page anyone or write a chart itself.
"""

from __future__ import annotations

import os

from koboi.tools.registry import tool
from koboi.types import RiskLevel

ESCALATION_LOG_PATH = "/data/escalations.log"


@tool(
    name="flag_urgent_escalation",
    description=(
        "Flag a patient's intake conversation for urgent clinician review. "
        "Does not diagnose or write to any record."
    ),
    parameters={
        "type": "object",
        "properties": {
            "reason": {"type": "string", "description": "why this needs urgent attention"},
        },
        "required": ["reason"],
    },
    risk_level=RiskLevel.SAFE,
)
async def flag_urgent_escalation(reason: str) -> str:
    os.makedirs(os.path.dirname(ESCALATION_LOG_PATH), exist_ok=True)
    with open(ESCALATION_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(reason + "\n")
    return "Flagged for clinician review."
