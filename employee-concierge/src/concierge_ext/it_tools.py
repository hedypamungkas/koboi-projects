"""concierge_ext/it_tools.py -- the IT desk peer's tools.

All SAFE so they execute through the A2A peer_invoke path without needing an approval to
round-trip back to the front-door chat. Policy-violating access requests (prod-admin / root)
are deny-gated at the FRONT-DOOR concierge config (policy.rules), so they never reach this peer.
"""

from __future__ import annotations

import json
import time

from koboi.tools.registry import tool
from koboi.types import RiskLevel

_ASSETS: dict[str, dict] = {
    "AST-1001": {"asset_id": "AST-1001", "owner": "emp-42", "type": "laptop", "model": "MacBook Pro 14"},
    "AST-1002": {"asset_id": "AST-1002", "owner": "emp-43", "type": "laptop", "model": "ThinkPad X1"},
    "AST-2001": {"asset_id": "AST-2001", "owner": "emp-42", "type": "monitor", "model": "27\" 4K"},
}


@tool(
    name="lookup_asset",
    description="Look up an IT asset by asset id or owner employee id (e.g. AST-1001 or emp-42).",
    parameters={
        "type": "object",
        "properties": {"asset_or_owner": {"type": "string", "description": "Asset id (AST-...) or employee id (emp-...)"}},
        "required": ["asset_or_owner"],
    },
    risk_level=RiskLevel.SAFE,
)
async def lookup_asset(asset_or_owner: str) -> str:
    key = asset_or_owner.strip()
    if key in _ASSETS:
        return json.dumps(_ASSETS[key])
    hits = [a for a in _ASSETS.values() if a.get("owner") == key]
    if hits:
        return json.dumps(hits)
    return f"No asset found for {key!r}."


@tool(
    name="reset_password",
    description="Reset the password / unlock the account for an employee id (e.g. emp-42). Returns a temp one-time link.",
    parameters={
        "type": "object",
        "properties": {"employee_id": {"type": "string", "description": "Employee id, e.g. emp-42"}},
        "required": ["employee_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def reset_password(employee_id: str) -> str:
    # Mock: in production this would call the IdP. Returns a one-time reset link.
    token = f"rst-{abs(hash(employee_id)) % 1000000:06d}"
    return f"Password reset initiated for {employee_id}. One-time setup link: https://reset.northwind.example/{token} (mock -- no real IdP call)."


@tool(
    name="request_access",
    description=(
        "Request a role or group access for an employee. Note: prod-admin and root roles are "
        "policy-denied at the concierge front door and never reach this tool."
    ),
    parameters={
        "type": "object",
        "properties": {
            "employee_id": {"type": "string", "description": "Employee id, e.g. emp-42"},
            "role": {"type": "string", "description": "Role/group, e.g. github-org, datadog-readonly, prod-admin"},
            "reason": {"type": "string", "description": "Business reason for the access"},
        },
        "required": ["employee_id", "role", "reason"],
    },
    risk_level=RiskLevel.SAFE,
)
async def request_access(employee_id: str, role: str, reason: str) -> str:
    ticket = f"ACS-{int(time.time()) % 100000}"
    return f"Access request {ticket} filed for {employee_id} -> {role} ({reason}). Routed to the access-owner for approval. (mock -- no real IAM change.)"
