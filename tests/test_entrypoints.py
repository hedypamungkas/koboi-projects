"""Custom entrypoints must not parse config / require env at import time
(P1 bugs G+H). A bad config or unset ${OPENAI_API_KEY} should fail at main()
(server start), not crash every import (tests, uvicorn reload)."""
from __future__ import annotations

import re

from conftest import REPO_ROOT


def test_hr_entrypoint_has_no_module_level_build_app():
    src = (REPO_ROOT / "hr-screening/src/hr_ext/entrypoint.py").read_text()
    # `app = build_app()` at column 0 (module scope) is the import-time side effect.
    assert not re.search(r"^app\s*=\s*build_app\(\)", src, re.M), (
        "hr entrypoint builds the app at module top level -- importing it crashes "
        "on a missing config / unset env"
    )
    assert "def main" in src and 'if __name__ == "__main__"' in src


def test_finance_entrypoint_gated_behind_main():
    src = (REPO_ROOT / "finance-reconciliation/src/finance_ext/entrypoint.py").read_text()
    assert 'if __name__ == "__main__"' in src, "finance entrypoint must gate build/run behind __main__"
