"""ecommerce_ext/tools -- Anvil & Co order lookup, return eligibility, and refunds.

No real Shopify Admin API integration exists in this demo -- ``_MOCK_ORDERS``
stands in for it. ``lookup_order`` and ``check_return_eligibility`` are safe
reads; ``initiate_refund`` is marked DESTRUCTIVE so koboi's approval flow
pauses it for a human before anything "happens" (this demo just returns a
confirmation string -- there's no payment system behind it).
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta

from koboi.tools.registry import tool
from koboi.types import RiskLevel

#: Return window, in days, from the ship date.
RETURN_WINDOW_DAYS = 30

#: Small in-memory stand-in for Anvil's order management system. Keys are
#: normalized order IDs (no leading "#", case-insensitive lookup).
_MOCK_ORDERS: dict[str, dict] = {
    "10234": {
        "order_id": "10234",
        "status": "shipped",
        "items": [
            {"sku": "ANV-TBL-OAK-01", "name": "Oak Coffee Table", "qty": 1},
            {"sku": "ANV-COAST-4PK", "name": "Woven Coaster Set (4-pack)", "qty": 1},
        ],
        "shipped_date": "2026-06-28",
        "carrier": "UPS",
        "tracking_number": "1Z999AA10123456784",
        "total_amount": 249.98,
    },
    "10088": {
        "order_id": "10088",
        "status": "delivered",
        "items": [
            {"sku": "ANV-LMP-BRS-02", "name": "Brass Floor Lamp", "qty": 1},
        ],
        "shipped_date": "2026-04-02",
        "carrier": "FedEx",
        "tracking_number": "781234567890",
        "total_amount": 189.00,
    },
    "10301": {
        "order_id": "10301",
        "status": "processing",
        "items": [
            {"sku": "ANV-RUG-JUT-5X7", "name": "Jute Area Rug 5x7", "qty": 1},
        ],
        "shipped_date": None,
        "carrier": None,
        "tracking_number": None,
        "total_amount": 129.50,
    },
    "10450": {
        "order_id": "10450",
        "status": "delivered",
        "items": [
            {"sku": "ANV-MUG-CER-SET6", "name": "Ceramic Mug Set (6-pack)", "qty": 1},
            {"sku": "ANV-TRAY-WD-01", "name": "Walnut Serving Tray", "qty": 1},
        ],
        "shipped_date": "2026-06-20",
        "carrier": "USPS",
        "tracking_number": "9400111899223197428379",
        "total_amount": 74.99,
    },
}


def _normalize_order_id(order_id: str) -> str:
    """Strip a leading '#' and surrounding whitespace so '#10234' == '10234'."""
    return order_id.strip().lstrip("#").strip()


def _find_order(order_id: str) -> dict | None:
    return _MOCK_ORDERS.get(_normalize_order_id(order_id))


@tool(
    name="lookup_order",
    description="Look up an order by ID and return its status, items, and shipping info.",
    parameters={
        "type": "object",
        "properties": {"order_id": {"type": "string", "description": "e.g. '10234' or '#10234'"}},
        "required": ["order_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def lookup_order(order_id: str) -> str:
    order = _find_order(order_id)
    if order is None:
        return f"No order found matching '{order_id}'. Double-check the order number and try again."
    return json.dumps(order)


@tool(
    name="check_return_eligibility",
    description="Check whether an order is still within Anvil & Co's 30-day return window.",
    parameters={
        "type": "object",
        "properties": {"order_id": {"type": "string", "description": "e.g. '10234' or '#10234'"}},
        "required": ["order_id"],
    },
    risk_level=RiskLevel.SAFE,
)
async def check_return_eligibility(order_id: str) -> str:
    order = _find_order(order_id)
    if order is None:
        return f"No order found matching '{order_id}'. Cannot determine return eligibility."

    shipped_date = order.get("shipped_date")
    if not shipped_date:
        return (
            f"Order {order['order_id']} has not shipped yet (status: {order['status']}). "
            "It is not eligible for a return until it has shipped and been received."
        )

    shipped = datetime.strptime(shipped_date, "%Y-%m-%d").date()
    days_since_shipped = (date.today() - shipped).days
    window_end = shipped + timedelta(days=RETURN_WINDOW_DAYS)

    if days_since_shipped <= RETURN_WINDOW_DAYS:
        return (
            f"Order {order['order_id']} is eligible for return: shipped {shipped_date}, "
            f"{RETURN_WINDOW_DAYS - days_since_shipped} day(s) left in the return window "
            f"(window ends {window_end.isoformat()})."
        )
    return (
        f"Order {order['order_id']} is NOT eligible for return: shipped {shipped_date}, "
        f"the {RETURN_WINDOW_DAYS}-day return window closed on {window_end.isoformat()} "
        f"({days_since_shipped - RETURN_WINDOW_DAYS} day(s) ago)."
    )


@tool(
    name="initiate_refund",
    description=(
        "Start a refund for an order. Requires human approval before it takes effect -- "
        "always call this rather than promising a refund yourself."
    ),
    parameters={
        "type": "object",
        "properties": {
            "order_id": {"type": "string", "description": "e.g. '10234' or '#10234'"},
            "amount": {"type": "number", "description": "Refund amount in dollars, e.g. 249.98"},
            "reason": {"type": "string", "description": "Why the customer is being refunded"},
        },
        "required": ["order_id", "amount", "reason"],
    },
    risk_level=RiskLevel.DESTRUCTIVE,
)
async def initiate_refund(order_id: str, amount: float, reason: str) -> str:
    order = _find_order(order_id)
    if order is None:
        return (
            f"Cannot initiate a refund: no order found matching '{order_id}'. "
            "Double-check the order number before retrying."
        )
    # No real payment system behind this demo -- just a confirmation string.
    # The DESTRUCTIVE risk level is what actually pauses this for a human;
    # by the time this function body runs, approval has already happened.
    return (
        f"Refund of ${amount:.2f} for order {order['order_id']} has been initiated "
        f"(reason: {reason}). It will be processed to the original payment method "
        "within 3-5 business days."
    )
