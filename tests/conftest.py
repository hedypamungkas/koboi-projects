"""Shared pytest fixtures + path setup for the Layer-1 test harness.

Layer-1 = no Docker, no LLM, <30s. Run from the repo root with the sibling
koboi-agent venv:

    ../koboi-agent/.venv/bin/python -m pytest -q

Each use case's ``src/`` is added to sys.path so ``import <pkg>_ext.tools`` works.
Config-structural checks read the raw YAML with pyyaml (version-robust across
koboi point releases); the "parses" check uses ``koboi.config.Config.from_yaml``.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# use case name -> (package importable from <uc>/src, backend API port, web port)
USE_CASES = {
    "ecommerce-support": ("ecommerce_ext", 8001),
    "hr-screening": ("hr_ext", 8002),
    "finance-reconciliation": ("finance_ext", 8003),
    "healthcare-intake": ("healthcare_ext", 8004),
    "legal-contract-review": ("legal_ext", 8005),
    "real-estate": ("realestate_ext", 8006),
    "insurance-claims": ("claims_ext", 8007),
    "market-intel": (None, 8008),  # config-only -- no custom Python
    "employee-concierge": ("concierge_ext", 8009),
    "customer-success": ("cs_ext", 8010),
}

# Env placeholders so every ${VAR} in every config resolves during the parse check.
PLACEHOLDER_ENV = {
    "OPENAI_API_KEY": "sk-test",
    "OPENAI_MODEL": "gpt-4o-mini",
    "OPENAI_BASE_URL": "",
    "EMBEDDING_API_KEY": "sk-test",
    "EMBEDDING_BASE_URL": "",
    "CONCIERGE_API_KEY": "concierge-smoke-key-1234",
    "A2A_ORG_SECRET": "org-secret-test",
    "WEB_SEARCH_PROVIDER": "mock",
    "WEB_SEARCH_API_KEY": "test",
    "BRAVE_API_KEY": "test",
    "FIRECRAWL_API_KEY": "test",
}


def pytest_configure(config):
    # Make each use case's extension package importable.
    for uc, (pkg, _) in USE_CASES.items():
        src = REPO_ROOT / uc / "src"
        if pkg and src.is_dir():
            sys.path.insert(0, str(src))
    # Seed the env so Config.from_yaml's ${VAR} substitution resolves.
    for k, v in PLACEHOLDER_ENV.items():
        os.environ.setdefault(k, v)


def uc_path(uc: str) -> Path:
    return REPO_ROOT / uc


def config_path(uc: str) -> Path:
    # employee-concierge's front door is concierge.yaml; everything else agent.yaml.
    name = "concierge.yaml" if uc == "employee-concierge" else "agent.yaml"
    return uc_path(uc) / "config" / name
