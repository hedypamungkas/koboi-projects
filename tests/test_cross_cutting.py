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


def test_market_intel_stream_timeout_exceeds_llm_timeout():
    """market-intel: the chat stream timeout must be >= llm.timeout + headroom,
    else the client cuts off a legit long deep_research while the backend still
    works (the timeout-inversion bug)."""
    import re
    appjs = (uc_path("market-intel") / "frontend" / "app.js").read_text()
    cfg = yaml.safe_load(config_path("market-intel").read_text())
    m = re.search(r"STREAM_TIMEOUT_MS\s*=\s*([\d_]+)", appjs)
    assert m, "market-intel app.js: STREAM_TIMEOUT_MS not found"
    stream_ms = int(m.group(1).replace("_", ""))  # handle JS numeric separators (330_000)
    llm_timeout_s = cfg.get("llm", {}).get("timeout")
    assert llm_timeout_s, "market-intel config: llm.timeout not found"
    assert stream_ms >= llm_timeout_s * 1000 + 30000, (
        f"market-intel: STREAM_TIMEOUT_MS ({stream_ms}ms) < llm.timeout ({llm_timeout_s}s)+headroom -- timeout inversion"
    )
    """employee-concierge's front door must gate on peer-it + peer-facilities being
    healthy, not just started (the A2A start-order race)."""
    doc = yaml.safe_load((uc_path("employee-concierge") / "docker-compose.yml").read_text())
    dep = doc["services"]["concierge"].get("depends_on")
    assert isinstance(dep, dict), "concierge depends_on must be the long form (dict)"
    for peer in ("peer-it", "peer-facilities"):
        assert dep.get(peer, {}).get("condition") == "service_healthy", (
            f"concierge must wait for {peer} to be healthy"
        )


# ---- docker: .dockerignore at the build-context root (each use-case dir) ---
# Docker reads .dockerignore from the BUILD-CONTEXT root. Each compose service
# uses `context: .` (the use-case dir), so a .dockerignore at the repo root is
# never consulted -- it must live in each use-case dir or .env (secrets) leaks
# into the build context.
@pytest.mark.parametrize("uc", UCS)
def test_dockerignore_at_build_context_root(uc):
    di = uc_path(uc) / ".dockerignore"
    assert di.is_file(), f"{uc}: no .dockerignore in the use-case dir (the build-context root)"
    body = di.read_text()
    assert ".env" in body, f"{uc}: .dockerignore does not exclude .env (secret leak into build context)"


# ---- frontend: no raw dynamic innerHTML/insertAdjacentHTML sinks ------------
# Static scan for template-literal sinks (innerHTML/outerHTML assignments and
# insertAdjacentHTML) interpolating ${...}. A sink is safe only if the value is
# wrapped in an escaping helper or is a known constant. NOTE: this catches
# template-literal interpolation, the form used in this repo; it cannot catch
# arbitrary `innerHTML = "<x>" + dynamic` string-concat (no static scanner can
# without a JS parser) -- the escapeHtml helper + code review cover that.
_RAW_HTML_SINK = re.compile(r"(?:\.innerHTML|\.outerHTML)\s*[+]?=\s*`[^`]*\$\{([^}`]+)\}|insertAdjacentHTML\([^,]*,\s*`[^`]*\$\{([^}`]+)\}")
_SAFE = re.compile(r"(escapeHtml|escHtml|escape\(|md\(|mdBrief\(|sanitiz)")
_CONST = re.compile(r"^(ROLE\.|ICON|empty|<)", re.I)


@pytest.mark.parametrize("uc", UCS)
def test_frontend_no_raw_html_sink(uc):
    appjs = uc_path(uc) / "frontend" / "app.js"
    if not appjs.is_file():
        pytest.skip(f"{uc}: no frontend/app.js")
    for line_no, line in enumerate(appjs.read_text().splitlines(), 1):
        for m in _RAW_HTML_SINK.finditer(line):
            expr = (m.group(1) or m.group(2) or "").strip()
            if _SAFE.search(line) or _CONST.match(expr):
                continue
            pytest.fail(f"{uc}/frontend/app.js:{line_no}: raw HTML sink `${{{expr}}}` -- escape it (XSS)")


# ---- frontend: API_BASE resolves from the browser hostname (remote-safe) ----
# A hardcoded `API_BASE = "http://localhost:NNNN"` only works when the browser
# runs on the Docker host itself; opening the UI from a remote machine (e.g. a
# VPS IP) sends every fetch to the viewer's own localhost and it fails. The base
# must be derived from window.location.hostname instead, so the same bundle works
# from localhost, a VPS IP, or a domain (and falls back to same-origin "" behind
# a reverse proxy).
@pytest.mark.parametrize("uc", UCS)
def test_frontend_api_base_uses_hostname(uc):
    appjs = uc_path(uc) / "frontend" / "app.js"
    if not appjs.is_file():
        pytest.skip(f"{uc}: no frontend/app.js")
    src = appjs.read_text()
    # hostname must be used INSIDE the API_BASE expression (between the
    # assignment and its terminating ';'), not merely mentioned in a comment --
    # a hardcoded `API_BASE = "http://localhost:NNNN"` only works when the
    # browser runs on the Docker host; opening the UI from a remote machine
    # (e.g. a VPS IP) sends every fetch to the viewer's own localhost.
    assert re.search(r'API_BASE\b[^;]{0,200}window\.location\.hostname', src), (
        f"{uc}/frontend/app.js: API_BASE must use window.location.hostname in "
        "its own expression (remote-safe), not hardcode localhost or only "
        "mention hostname in a comment"
    )
    # The web-port gate (window.location.port === "<webport>") makes API_BASE
    # derive the backend host from the page origin and fall back to same-origin
    # "" behind a reverse proxy, instead of forcing a cross-origin host:port.
    assert re.search(r'window\.location\.port\s*===\s*"\d{4}"', src), (
        f"{uc}/frontend/app.js: API_BASE must gate on "
        "window.location.port === \"<webport>\" (falling back to same-origin \"\" "
        "behind a reverse proxy)"
    )
    assert not re.search(r'API_BASE\s*=\s*"http://localhost', src), (
        f"{uc}/frontend/app.js: hardcoded localhost API_BASE -- breaks when "
        "the UI is opened from a remote browser"
    )
