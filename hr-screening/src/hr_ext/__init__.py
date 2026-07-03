"""hr_ext -- Northstar Talent resume-screening extensions for koboi-agent.

Business logic layer consumed by koboi-agent as an installed package (no fork,
no core changes): two tools (`fetch_resume`, `score_candidate`) plus an audit
hook (`ScoringAuditHook`) wired in via `koboi.server.app.create_app(extra_hooks=...)`.
"""
