"""finance-reconciliation: audit hook has no import-time makedirs (P1 bug G) and
appends are concurrency-safe under the lock (P2: no interleaved JSONL rows)."""
from __future__ import annotations

import asyncio
import json
import re

from conftest import REPO_ROOT


def test_no_import_time_makedirs():
    """hooks.py must not touch the filesystem at import time (was a boot crash
    if /data/audit wasn't writable on first import)."""
    src = (REPO_ROOT / "finance-reconciliation/src/finance_ext/hooks.py").read_text()
    # A module-level (zero-indent) os.makedirs call is the bug.
    bad = [l for l in src.splitlines() if re.match(r"^os\.makedirs", l.strip()) and not l.startswith(" ")]
    assert not bad, f"import-time makedirs found: {bad}"


def test_append_row_creates_dir_and_is_concurrency_safe(tmp_path):
    import finance_ext.hooks as fh
    fh.AUDIT_LOG_PATH = str(tmp_path / "audit/inv.jsonl")  # dir does not exist yet
    rows = [{"ts": i, "tool": f"t{i}", "args": "x" * 6000, "result": None} for i in range(30)]

    async def run():
        # _append_row is sync + lock; run many concurrently via to_thread like the hook does.
        await asyncio.gather(*[asyncio.to_thread(fh._append_row, r) for r in rows])

    asyncio.run(run())
    lines = (tmp_path / "audit/inv.jsonl").read_text().splitlines()
    # Every line must be valid JSON (no interleaving) and all 30 rows present.
    parsed = []
    for ln in lines:
        if ln.strip():
            parsed.append(json.loads(ln))  # raises on a half-written/interleaved row
    assert len(parsed) == 30, f"lost rows: {len(parsed)}/30"
