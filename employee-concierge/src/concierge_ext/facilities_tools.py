"""concierge_ext/facilities_tools.py -- the Facilities desk peer's tools.

All SAFE so they execute through the A2A peer_invoke path without an approval round-trip.
"""

from __future__ import annotations

import json
import time

from koboi.tools.registry import tool
from koboi.types import RiskLevel

_DESKS: dict[str, dict] = {
    "emp-42": {"employee_id": "emp-42", "floor": "4", "desk": "4-A-12", "building": "HQ-North"},
    "emp-43": {"employee_id": "emp-43", "floor": "3", "desk": "3-B-07", "building": "HQ-North"},
}


@tool(
    name="lookup_desk",
    description="Look up an employee's current desk assignment by employee id (e.g. emp-42).",
    parameters={
        "type": "object",
        "properties": {"employee_id": {"type": "string", "description": "Employee id, e.g. emp-42"}},
        "required": ["employee_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def lookup_desk(employee_id: str) -> str:
    desk = _DESKS.get(employee_id.strip())
    if desk is None:
        return f"No desk assignment found for {employee_id!r}."
    return json.dumps(desk)


@tool(
    name="book_desk_move",
    description="Book a desk move / relocation for an employee to a target floor and desk.",
    parameters={
        "type": "object",
        "properties": {
            "employee_id": {"type": "string", "description": "Employee id, e.g. emp-42"},
            "target_floor": {"type": "string", "description": "Target floor, e.g. 5"},
            "target_desk": {"type": "string", "description": "Target desk, e.g. 5-C-20"},
        },
        "required": ["employee_id", "target_floor", "target_desk"],
    },
    risk_level=RiskLevel.SAFE,
)
async def book_desk_move(employee_id: str, target_floor: str, target_desk: str) -> str:
    ref = f"MV-{int(time.time()) % 100000}"
    return f"Desk move {ref} booked for {employee_id} -> floor {target_floor}, desk {target_desk}. Scheduled for the next facilities window. (mock -- no real move.)"


@tool(
    name="report_maintenance",
    description="Log a building/maintenance issue (e.g. broken AC, lighting, plumbing).",
    parameters={
        "type": "object",
        "properties": {
            "location": {"type": "string", "description": "Where the issue is, e.g. '4th floor kitchen'"},
            "issue": {"type": "string", "description": "Description of the issue"},
        },
        "required": ["location", "issue"],
    },
    risk_level=RiskLevel.SAFE,
)
async def report_maintenance(location: str, issue: str) -> str:
    ref = f"MNT-{int(time.time()) % 100000}"
    return f"Maintenance ticket {ref} logged for {location}: {issue}. Routed to the building ops team. (mock -- no real ticket system.)"
