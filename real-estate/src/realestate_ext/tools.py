"""realestate_ext/tools -- Harbor Realty Group CRM stand-ins.

No real CRM is wired up for this demo. `_PROPERTIES` and `_LEADS` are small
in-memory tables that stand in for a Yardi/AppFolio-style CRM's read API.
`draft_listing_description` and `draft_followup_email` only ever write into
an in-memory "drafts" dict -- nothing is published or sent. A human agent
reviews drafts (see the dashboard in frontend/) and publishes/sends through
the CRM's own tools, never through koboi.
"""

from __future__ import annotations

import json
import os
import threading
import time

from koboi.tools.registry import tool
from koboi.types import RiskLevel

# ---------------------------------------------------------------------------
# Sample data -- stands in for the CRM. Real deployment would call out to
# Harbor's Yardi/AppFolio/HubSpot-style API instead of reading these dicts.
# ---------------------------------------------------------------------------

_PROPERTIES: dict[str, dict] = {
    "P-101": {
        "address": "42 Harbor View Dr, Unit 3B, Seattle, WA",
        "type": "Condo",
        "beds": 2,
        "baths": 2,
        "sqft": 1120,
        "price": 585000,
        "status": "for_sale",
        "raw_features": [
            "floor-to-ceiling windows facing the marina",
            "in-unit washer/dryer",
            "1 reserved garage parking spot",
            "pet friendly, no weight limit",
            "walking distance to the waterfront trail",
            "building has a rooftop deck and gym",
        ],
    },
    "P-102": {
        "address": "118 Cedar Grove Ln, Portland, OR",
        "type": "Single Family",
        "beds": 4,
        "baths": 3,
        "sqft": 2450,
        "price": 749000,
        "status": "for_sale",
        "raw_features": [
            "fully fenced backyard",
            "detached 2-car garage",
            "updated kitchen with quartz counters",
            "finished basement, could be a home office or gym",
            "top-rated elementary school district",
        ],
    },
    "P-103": {
        "address": "900 Riverside Ave, Apt 12, Austin, TX",
        "type": "Apartment (rental)",
        "beds": 1,
        "baths": 1,
        "sqft": 780,
        "price": 1850,  # monthly rent
        "status": "for_rent",
        "raw_features": [
            "on-site pool and coworking lounge",
            "pet friendly with $300 deposit",
            "assigned covered parking",
            "10 minute walk to the greenbelt trailhead",
        ],
    },
    "P-104": {
        "address": "27 Maple Court, Denver, CO",
        "type": "Townhouse",
        "beds": 3,
        "baths": 2.5,
        "sqft": 1680,
        "price": 512000,
        "status": "for_sale",
        "raw_features": [
            "mountain views from the primary bedroom",
            "attached 1-car garage",
            "low-maintenance HOA covers landscaping and snow removal",
            "new roof (2024)",
        ],
    },
}

_LEADS: dict[str, dict] = {
    "L-001": {
        "name": "Priya Nair",
        "interested_in": "P-101",
        "last_contact": "2026-06-25",
        "notes": "Asked about pet policy and parking; very responsive so far.",
    },
    "L-002": {
        "name": "Marcus Webb",
        "interested_in": "P-102",
        "last_contact": "2026-06-20",
        "notes": "Toured the property in person, went quiet after. Stale lead -- follow up.",
    },
    "L-003": {
        "name": "Jordan Alvarez",
        "interested_in": "P-104",
        "last_contact": "2026-06-27",
        "notes": "Pre-approved for financing, comparing against two other townhouses.",
    },
}

# Durable "pending review" queue -- stands in for the CRM's draft field /
# pending-send queue. Never flipped to published/sent by this code.
#
# Was two module-level mutable dicts; under jobs.max_concurrent + delegate_tasks
# that meant (a) drafts lost on container restart despite the "saved to the CRM"
# message, (b) last-write-wins loss / cross-session leak across pooled jobs, and
# (c) the dicts were never read back anyway. A locked JSONL append is durable,
# concurrency-safe, and one-record-per-line (json.dumps escapes newlines) -- P1 bug F.
DRAFTS_LOG_PATH = os.environ.get("RE_DRAFTS_LOG", "/data/realestate_drafts.jsonl")
_DRAFT_LOCK = threading.Lock()


def _save_draft(kind: str, key: str, draft: str) -> None:
    """Append one draft record to the durable review queue."""
    os.makedirs(os.path.dirname(DRAFTS_LOG_PATH) or ".", exist_ok=True)
    record = {"kind": kind, "key": key, "draft": draft, "saved_at": time.time()}
    line = json.dumps(record, ensure_ascii=False)
    with _DRAFT_LOCK, open(DRAFTS_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


@tool(
    name="lookup_property",
    description="Look up a property listing by ID.",
    parameters={
        "type": "object",
        "properties": {"property_id": {"type": "string"}},
        "required": ["property_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def lookup_property(property_id: str) -> str:
    prop = _PROPERTIES.get(property_id)
    if prop is None:
        return f"No property found with ID '{property_id}'. Known IDs: {', '.join(sorted(_PROPERTIES))}"

    price_label = "rent/mo" if prop["status"] == "for_rent" else "price"
    lines = [
        f"Property {property_id}: {prop['address']}",
        f"Type: {prop['type']} | {prop['beds']} bed / {prop['baths']} bath | {prop['sqft']} sqft",
        f"Status: {prop['status']} | {price_label}: ${prop['price']:,}",
        "Features: " + "; ".join(prop["raw_features"]),
    ]
    return "\n".join(lines)


@tool(
    name="draft_listing_description",
    description="Draft a marketing description for a property. Does not publish anything.",
    parameters={
        "type": "object",
        "properties": {"property_id": {"type": "string"}},
        "required": ["property_id"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def draft_listing_description(property_id: str) -> str:
    prop = _PROPERTIES.get(property_id)
    if prop is None:
        return f"Cannot draft: no property found with ID '{property_id}'."

    price_label = "Available for rent at" if prop["status"] == "for_rent" else "Offered at"
    price_value = f"${prop['price']:,}" + ("/mo" if prop["status"] == "for_rent" else "")
    feature_bullets = "\n".join(f"- {f}" for f in prop["raw_features"])
    draft = (
        f"{prop['beds']}BR/{prop['baths']}BA {prop['type']} in a great location -- "
        f"{prop['address']}.\n\n"
        f"This {prop['sqft']}-sqft home offers:\n{feature_bullets}\n\n"
        f"{price_label} {price_value}. Schedule a tour today!"
    )
    _save_draft("listing", property_id, draft)
    return (
        f"Draft listing description for {property_id} saved to the CRM's draft field "
        f"(not published -- awaiting human review):\n\n{draft}"
    )


@tool(
    name="draft_followup_email",
    description="Draft a follow-up email to a lead. Does not send anything.",
    parameters={
        "type": "object",
        "properties": {"lead_id": {"type": "string"}},
        "required": ["lead_id"],
    },
    risk_level=RiskLevel.MODERATE,
)
async def draft_followup_email(lead_id: str) -> str:
    lead = _LEADS.get(lead_id)
    if lead is None:
        return f"Cannot draft: no lead found with ID '{lead_id}'."

    prop = _PROPERTIES.get(lead["interested_in"], {})
    address = prop.get("address", lead["interested_in"])
    draft = (
        f"Subject: Following up on {address}\n\n"
        f"Hi {lead['name']},\n\n"
        f"I wanted to check back in about {address} -- we last connected on "
        f"{lead['last_contact']} and I didn't want you to miss out. "
        f"{lead.get('notes', '')}\n\n"
        "Happy to answer any questions or set up another showing whenever works for you.\n\n"
        "Best,\nHarbor Realty Group"
    )
    _save_draft("email", lead_id, draft)
    return (
        f"Draft follow-up email for lead {lead_id} ({lead['name']}) saved to the CRM's "
        f"pending-send queue (not sent -- awaiting human review):\n\n{draft}"
    )
