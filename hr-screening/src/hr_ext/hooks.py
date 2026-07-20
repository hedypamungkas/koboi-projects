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
(v0.18.2) -- `HookContext.tool_arguments` is the *raw JSON string* the LLM
produced for the tool call (mirrors `koboi.types.ToolCall.arguments: str`), not
a parsed dict. It must be `json.loads`-ed here.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time

from koboi.hooks.chain import Hook, HookContext, HookEvent

_logger = logging.getLogger(__name__)

AUDIT_LOG_PATH = os.environ.get("HR_AUDIT_LOG_PATH", "/data/audit/scoring_audit.jsonl")
# Serializes concurrent appends from pooled jobs (max_concurrent > 1) so two
# large rows can't interleave their chunked BufferedWriter writes. Mirrors the
# finance InvoiceAuditHook pattern.
_AUDIT_LOCK = threading.Lock()


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
        if "_raw" in args:
            # Preserve the unparseable input so the audit trail shows what the LLM
            # actually emitted, not just all-None fields.
            record["_raw"] = args["_raw"]
        # Blocking file I/O off the event loop, under a lock -- this hook fires
        # on every score_candidate across every pooled session.
        await asyncio.to_thread(_append_record, record)

        return ctx


def _append_record(record: dict) -> None:
    os.makedirs(os.path.dirname(AUDIT_LOG_PATH) or ".", exist_ok=True)
    line = json.dumps(record, ensure_ascii=False)
    with _AUDIT_LOCK, open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")
