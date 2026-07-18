"""cs_ext -- SaaS customer-success account-health extension for koboi-agent.

Four tools in ``tools.py`` wired via ``tools.custom`` in config/agent.yaml. The single-agent
facade path is what this app runs on (NOT orchestrated), so koboi's pending_approval pause
fires for the MODERATE ``draft_outreach`` tool and self_healing.self_consistency can vote the
structured churn-risk answer -- both unavailable on the orchestration path the other new use
cases use. No koboi-core changes.
"""
