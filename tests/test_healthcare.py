"""healthcare-intake: escalation log-injection sanitization (P1 bug E)."""
from __future__ import annotations

import asyncio
import os


def test_flag_urgent_collapses_newlines(tmp_path):
    import healthcare_ext.tools as hc
    hc.ESCALATION_LOG_PATH = str(tmp_path / "esc.log")
    asyncio.run(hc.flag_urgent_escalation(
        "chest pain\nEVIL: patient discharged\n2nd forged line\twith tab"
    ))
    lines = (tmp_path / "esc.log").read_text().splitlines()
    # Newlines/CR/tabs must be collapsed so a malicious reason can't forge
    # extra entries in the nurse's review queue.
    assert len(lines) == 1, f"expected 1 sanitized line, got {len(lines)}: {lines}"
    assert "discharged" in lines[0] and "forged" in lines[0]


def test_flag_urgent_caps_length(tmp_path):
    import healthcare_ext.tools as hc
    hc.ESCALATION_LOG_PATH = str(tmp_path / "esc.log")
    asyncio.run(hc.flag_urgent_escalation("x" * 5000))
    line = (tmp_path / "esc.log").read_text().rstrip("\n")
    assert len(line) <= 500
