"""hr_ext/hooks -- ScoringAuditHook.

The safety net for a job that runs with no live human approval: every
`score_candidate` call gets appended to a durable, append-only log before
anything downstream (dashboard, recruiter) can act on it, so a bias/compliance
review always has the full rationale to check.

NOTE on wiring: koboi's `koboi serve <config>` CLI has no YAML key or entry-point
group for custom hooks (only tools/RAG/context support `custom_modules` /
`tools.custom`). `Hook` instances must instead be passed to
`koboi.server.app.create_app(config, extra_hooks=[...])` at process startup --
see `hr_ext/entrypoint.py`.

NOTE on `ctx.tool_arguments`: verified against the installed `koboi.hooks.chain`
(v0.2.0) -- `HookContext.tool_arguments` is the *raw JSON string* the LLM
produced for the tool call (mirrors `koboi.types.ToolCall.arguments: str`), not
a parsed dict. It must be `json.loads`-ed here.
"""

from __future__ import annotations

import json
import logging
import os
import time

from koboi.hooks.chain import Hook, HookContext, HookEvent

_logger = logging.getLogger(__name__)

AUDIT_LOG_PATH = os.environ.get("HR_AUDIT_LOG_PATH", "/data/audit/scoring_audit.jsonl")


class ScoringAuditHook(Hook):
    """Appends a durable record of every `score_candidate` call."""

    def handles(self) -> list[HookEvent]:
        return [HookEvent.POST_TOOL_USE]

    async def execute(self, ctx: HookContext) -> HookContext:
        if ctx.tool_name != "score_candidate":
            return ctx

        try:
            args = json.loads(ctx.tool_arguments) if ctx.tool_arguments else {}
        except json.JSONDecodeError:
            _logger.warning("ScoringAuditHook: could not parse tool_arguments as JSON: %r", ctx.tool_arguments)
            args = {"_raw": ctx.tool_arguments}

        record = {
            "logged_at": time.time(),
            "resume_id": args.get("resume_id"),
            "score": args.get("score"),
            "rationale": args.get("rationale"),
            "recommendation": args.get("recommendation"),
            "tool_result": ctx.tool_result,
        }

        os.makedirs(os.path.dirname(AUDIT_LOG_PATH), exist_ok=True)
        with open(AUDIT_LOG_PATH, "a") as f:
            f.write(json.dumps(record) + "\n")

        return ctx
