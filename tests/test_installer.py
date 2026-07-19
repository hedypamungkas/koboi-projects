"""quickstart installer regression pack (Layer-1, no Docker).

Guards the proven installer bugs so they can't return: the `--project`-no-value
hang (P0-1), dead `--no-color`/`--no-utf8` flags (P0-3), `--yes`-without-`--project`,
and the `bash -n` + shellcheck syntax gates. Runs the script's own subcommands
(`--list`) so the assertions exercise real code paths.
"""
from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from conftest import REPO_ROOT

QS = REPO_ROOT / "quickstart.sh"
PS1 = REPO_ROOT / "quickstart.ps1"


def _run(args, env=None, timeout=15):
    e = os.environ.copy()
    if env:
        e.update(env)
    return subprocess.run(["bash", str(QS), *args], capture_output=True, text=True,
                          env=e, timeout=timeout, cwd=str(REPO_ROOT))


def test_bash_syntax_clean():
    r = subprocess.run(["bash", "-n", str(QS)], capture_output=True, text=True)
    assert r.returncode == 0, f"bash -n failed:\n{r.stderr}"


def test_shellcheck_clean_if_available():
    if not shutil.which("shellcheck"):
        pytest.skip("shellcheck not installed")
    r = subprocess.run(["shellcheck", "-S", "warning", str(QS)], capture_output=True, text=True)
    assert r.returncode == 0, f"shellcheck found issues:\n{r.stdout}\n{r.stderr}"


def test_project_with_no_value_does_not_hang():
    """P0-1: `--project` with no value must die cleanly, not spin forever."""
    try:
        r = _run(["--project"], env={"KOBOI_UC_HOME": "/tmp/qs-nonexistent"}, timeout=8)
    except subprocess.TimeoutExpired:
        pytest.fail("--project with no value hung (infinite loop) -- P0-1 regressed")
    assert r.returncode != 0
    assert "requires a project name" in r.stderr, f"unexpected stderr: {r.stderr}"


def test_yes_without_project_dies_cleanly():
    try:
        r = _run(["--yes"], env={"KOBOI_UC_HOME": "/tmp/qs-nonexistent"}, timeout=8)
    except subprocess.TimeoutExpired:
        pytest.fail("--yes without --project hung")
    assert r.returncode != 0
    assert "requires --project" in r.stderr


def test_no_color_flag_emits_no_ansi():
    """P0-3: --no-color must actually disable color (was parsed too late = dead)."""
    r = _run(["--no-color", "--list"])
    assert r.returncode == 0
    assert "\x1b[" not in r.stdout, "ANSI escape codes present despite --no-color"


def test_no_utf8_flag_emits_no_raw_unicode():
    """P0-3/B: --no-utf8 must not emit raw UTF-8 glyphs (banner/mojibake)."""
    r = _run(["--no-utf8", "--list"])
    # No raw non-ASCII bytes should reach stdout under --no-utf8.
    non_ascii = [b for b in r.stdout.encode() if b >= 0x80]
    assert not non_ascii, f"raw non-ASCII bytes under --no-utf8: {non_ascii[:20]}"


def test_list_shows_all_ten_projects_and_ports():
    r = _run(["--list"])
    out = r.stdout
    for name in ["ecommerce-support", "hr-screening", "finance-reconciliation",
                 "healthcare-intake", "legal-contract-review", "real-estate",
                 "insurance-claims", "market-intel", "employee-concierge", "customer-success"]:
        assert name in out, f"{name} missing from --list"
    # Port table spot-checks.
    assert ":8001" in out and ":8010" in out


def test_unknown_project_rejected():
    r = _run(["--project", "no-such-project"], env={"KOBOI_UC_HOME": "/tmp/qs-nonexistent"}, timeout=8)
    assert r.returncode != 0
    assert "unknown project" in r.stderr


def test_ps1_daemon_check_uses_lastexitcode():
    """P0-2: the .ps1 must test $LASTEXITCODE, not rely on try/catch (which never
    fires for a native exe returning nonzero)."""
    src = PS1.read_text()
    assert "$LASTEXITCODE" in src, "ps1 daemon check doesn't test $LASTEXITCODE (P0-2)"
    # And the broken try/catch on docker info should be gone.
    assert "try { docker info" not in src, "ps1 still uses try/catch around docker info"
