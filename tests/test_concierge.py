"""employee-concierge: the ID stability/uniqueness fixes.

Was: `abs(hash(employee_id))` (PYTHONHASHSEED-randomized -> different token per
restart) and `int(time.time()) % 100000` (same-second collisions under a batch
fan-out). Now: hashlib (deterministic) + secrets (unique). These pin the fix so
a revert is caught."""
from __future__ import annotations

import asyncio
import hashlib


def test_reset_password_token_is_stable():
    """Token must be a deterministic function of employee_id (hashlib, not hash())."""
    import concierge_ext.it_tools as it
    expected = "rst-" + hashlib.sha256(b"emp-42").hexdigest()[:6]
    out = asyncio.run(it.reset_password("emp-42"))
    assert expected in out, f"token not hashlib-stable: expected {expected!r} in {out!r}"


def test_request_access_refs_unique_under_burst():
    """20 same-second request_access calls must yield 20 unique refs (was time-collisions)."""
    import concierge_ext.it_tools as it

    async def burst():
        return await asyncio.gather(*[it.request_access("E", "r", "x") for _ in range(20)])

    results = asyncio.run(burst())
    # Extract the ACS- ref from each result string.
    refs = {r.split("ACS-")[1].split()[0] for r in results if "ACS-" in r}
    assert len(refs) == 20, f"refs not unique under burst: {len(refs)}/20 unique"


def test_facilities_refs_unique_under_burst():
    """book_desk_move + report_maintenance refs must be unique (was time-collisions)."""
    import re
    import concierge_ext.facilities_tools as ft

    async def burst():
        moves = await asyncio.gather(*[ft.book_desk_move("E", "3", "A") for _ in range(15)])
        maint = await asyncio.gather(*[ft.report_maintenance("loc", "broken") for _ in range(15)])
        return moves + maint

    results = asyncio.run(burst())
    refs = set(re.findall(r"(?:MV|MNT)-[0-9a-f]{6}", "\n".join(results)))
    assert len(refs) >= 29, f"facilities refs not unique under burst: {len(refs)} unique (expected ~30)"
