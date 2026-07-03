"""legal_ext/tools -- draft-only redline proposal and novel-clause escalation.

Neither tool sends, files, or signs anything -- both return text that lands in
the current chat turn or job output for a lawyer to read. ``propose_redline``
is MODERATE (not DESTRUCTIVE) because nothing leaves the session; the real
approval step is a human reading the draft before using it elsewhere.
``flag_novel_clause`` is SAFE for the same reason -- it's a read-only escalation
signal, not an action.
"""

from __future__ import annotations

from koboi.tools.registry import tool
from koboi.types import RiskLevel


@tool(
    name="propose_redline",
    description="Draft a suggested redline using the playbook's fallback language. Returns text only.",
    parameters={
        "type": "object",
        "properties": {
            "clause_type": {"type": "string"},
            "original_text": {"type": "string"},
            "playbook_fallback": {"type": "string"},
        },
        "required": ["clause_type", "original_text"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def propose_redline(clause_type: str, original_text: str, playbook_fallback: str = "") -> str:
    return (
        f"Suggested redline for {clause_type}:\n"
        f"{playbook_fallback or '[no fallback available -- escalate]'}"
    )


@tool(
    name="flag_novel_clause",
    description="Flag a clause with no playbook match, for a lawyer to look at directly.",
    parameters={
        "type": "object",
        "properties": {
            "clause_text": {"type": "string"},
            "reason": {"type": "string"},
        },
        "required": ["clause_text", "reason"],
    },
    risk_level=RiskLevel.SAFE,
)
async def flag_novel_clause(clause_text: str, reason: str) -> str:
    return f"Flagged for lawyer review: {reason}"
