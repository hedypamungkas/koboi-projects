"""Cross-cutting Layer-1 invariants parameterized over all 10 use cases.

Catches regressions in the post-release hardening: config parses against the
koboi 0.18.x schema; ports match the quickstart table; jobs-enabled configs are
sandboxed; api_keys/webhook defaults are sane; compose healthchecks + non-root
Dockerfiles are present; no raw (unescaped) dynamic innerHTML sinks.
"""
from __future__ import annotations

import os
import re
import subprocess
import textwrap

import pytest
import yaml

from conftest import REPO_ROOT, USE_CASES, config_path, uc_path

UCS = list(USE_CASES.keys())
# A ${VAR} with no default survives env-substitution as the literal string (koboi
# preserves it rather than crashing). For auth-critical api_keys that's an opaque
# 401, so any ${VAR} in api_keys MUST carry a default: ${VAR:fallback}.
BARE_DOLLAR = re.compile(r"\$\{[A-Z_]+\}")


# ---- config: parses --------------------------------------------------------
@pytest.mark.parametrize("uc", UCS)
def test_config_parses(uc):
    from koboi.config import Config
    Config.from_yaml(str(config_path(uc)))  # raises on schema/parse error


# ---- config: ports match the quickstart table ------------------------------
@pytest.mark.parametrize("uc", UCS)
def test_compose_host_port_matches_table(uc):
    compose = uc_path(uc) / "docker-compose.yml"
    doc = yaml.safe_load(compose.read_text())
    expected = USE_CASES[uc][1]
    # The koboi service (or 'concierge' for employee-concierge) maps host <expected>:8000.
    svc = "concierge" if uc == "employee-concierge" else "koboi"
    ports = doc["services"][svc]["ports"]
    host_ports = {str(p).split(":")[0] for p in ports}
    assert str(expected) in host_ports, f"{uc}: expected host port {expected}, got {host_ports}"


# ---- config: jobs => sandbox restricted ------------------------------------
@pytest.mark.parametrize("uc", UCS)
def test_jobs_enabled_implies_restricted_sandbox(uc):
    doc = yaml.safe_load(config_path(uc).read_text())
    jobs = doc.get("jobs") or {}
    if jobs.get("enabled"):
        sandbox = doc.get("sandbox") or {}
        assert sandbox.get("backend") == "restricted", (
            f"{uc}: jobs.enabled=true but sandbox.backend is "
            f"{sandbox.get('backend')!r} -- autonomous jobs raise PermissionError"
        )


# ---- config: api_keys with ${VAR} must carry a default ---------------------
@pytest.mark.parametrize("uc", UCS)
def test_api_keys_have_defaults(uc):
    doc = yaml.safe_load(config_path(uc).read_text())
    server = doc.get("server") or {}
    for key in server.get("api_keys") or []:
        assert not BARE_DOLLAR.search(str(key)), (
            f"{uc}: api_keys entry {key!r} has no default -- an unset env var "
            "survives as the literal string and causes an opaque 401"
        )


# ---- config: webhook URLs reachable from inside the container --------------
@pytest.mark.parametrize("uc", UCS)
def test_webhook_urls_reachable_in_container(uc):
    doc = yaml.safe_load(config_path(uc).read_text())
    webhooks = (doc.get("jobs") or {}).get("webhooks") or []
    # koboi shape: jobs.webhooks is a list of {url: ...} dicts.
    for wh in webhooks if isinstance(webhooks, list) else []:
        url = wh.get("url") if isinstance(wh, dict) else wh
        if url and "localhost:9999" in str(url):
            pytest.fail(f"{uc}: webhook {url!r} uses localhost:9999 -- unreachable inside the container; use host.docker.internal")


# ---- docker: compose healthcheck -------------------------------------------
@pytest.mark.parametrize("uc", UCS)
def test_compose_has_healthcheck(uc):
    doc = yaml.safe_load((uc_path(uc) / "docker-compose.yml").read_text())
    backends = ["concierge", "peer-it", "peer-facilities"] if uc == "employee-concierge" else ["koboi"]
    for svc in backends:
        assert doc["services"][svc].get("healthcheck"), f"{uc}: service {svc!r} has no healthcheck"
    # web/frontend waits for a *healthy* backend, not just container start.
    web = doc["services"].get("web") or doc["services"].get("frontend")
    if web:
        dep = web.get("depends_on")
        healthy = False
        if isinstance(dep, dict):
            healthy = any((v or {}).get("condition") == "service_healthy" for v in dep.values())
        assert healthy, f"{uc}: web does not gate on a healthy backend (depends_on condition: service_healthy)"


# ---- docker: non-root USER in backend Dockerfile ---------------------------
@pytest.mark.parametrize("uc", UCS)
def test_backend_dockerfile_non_root(uc):
    df = (uc_path(uc) / "backend" / "Dockerfile").read_text()
    assert re.search(r"^USER\s+\S+", df, re.M), f"{uc}: backend Dockerfile has no USER directive (runs as root)"
    # The non-root user must be able to write /data at runtime. A named volume
    # mounted on an EMPTY image dir is created root-owned (Docker ignores the
    # image chown), so koboi's sqlite sidecar (shared_db under /data) hits
    # "attempt to write a readonly database" and the container never boots. The
    # placeholder makes /data non-empty so first-mount inherits app ownership.
    assert "touch /data/.dockerkeep" in df, (
        f"{uc}: Dockerfile missing 'touch /data/.dockerkeep' -- non-root /data is root-owned, boot crashes"
    )


def test_concierge_waits_for_healthy_peers():
    """employee-concierge's front door must gate on peer-it + peer-facilities being
    healthy, not just started (the A2A start-order race)."""
    doc = yaml.safe_load((uc_path("employee-concierge") / "docker-compose.yml").read_text())
    dep = doc["services"]["concierge"].get("depends_on")
    assert isinstance(dep, dict), "concierge depends_on must be the long form (dict)"
    for peer in ("peer-it", "peer-facilities"):
        assert dep.get(peer, {}).get("condition") == "service_healthy", (
            f"concierge must wait for {peer} to be healthy"
        )


# ---- docker: root .dockerignore exists -------------------------------------
def test_root_dockerignore_exists():
    assert (REPO_ROOT / ".dockerignore").is_file(), "no root .dockerignore -- build context carries .git/__pycache__/.env slop"


# ---- frontend: no raw dynamic innerHTML sinks ------------------------------
# An innerHTML assignment interpolating ${...} is safe only if the value is
# wrapped in an escaping helper (escapeHtml/md/mdBrief) or is a known constant.
_RAW_INNERHTML = re.compile(r"\.innerHTML\s*[+]?=\s*`[^`]*\$\{([^}`]+)\}")
_SAFE = re.compile(r"(escapeHtml|escHtml|escape\(|md\(|mdBrief\(|sanitiz)")
_CONST = re.compile(r"^(ROLE\.|ICON|empty|<)", re.I)


@pytest.mark.parametrize("uc", UCS)
def test_frontend_no_raw_innerhtml_sink(uc):
    appjs = uc_path(uc) / "frontend" / "app.js"
    if not appjs.is_file():
        pytest.skip(f"{uc}: no frontend/app.js")
    for line_no, line in enumerate(appjs.read_text().splitlines(), 1):
        for m in _RAW_INNERHTML.finditer(line):
            expr = m.group(1).strip()
            # whole innerHTML already checked by helper on the line, or const/empty.
            if _SAFE.search(line) or _CONST.match(expr):
                continue
            pytest.fail(f"{uc}/frontend/app.js:{line_no}: raw innerHTML sink `${{{expr}}}` -- escape it (XSS)")
