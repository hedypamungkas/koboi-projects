"""claims_ext -- Beacon Mutual P&C FNOL triage extension for koboi-agent.

Plain extension (no koboi-core changes). The four specialist tools in ``tools.py``
are wired into the orchestrated triage DAG via ``orchestration.agents[*].tools.custom``
in config/agent.yaml (each DAG node loads the module and is told which tool to call by
its own system prompt). ``transfer_to_human`` is a koboi builtin, allowlisted on the
``decide`` node via ``tools.builtin``.
"""
