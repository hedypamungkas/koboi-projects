#!/usr/bin/env python3
"""scripts/open_ticket.py -- command-hook target for the concierge front door.

Spawned by koboi's declarative command hook (config/concierge.yaml `hooks.on_event`) on each
``post_output`` event. koboi passes a JSON HookContext on stdin; this script reads it and
appends a "ServiceNow-style" ticket row to /data/tickets.jsonl -- standing in for the real
ITSM integration. ``fire_and_forget: true`` means koboi does not wait on this script, so a
slow/flaky ITSM never stalls the agent's SSE stream.

Run standalone to test:
    echo '{"event":"post_output","session_id":"s1","output":"reset password for emp-42"}' | python3 scripts/open_ticket.py
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path

TICKETS_PATH = Path(os.environ.get("CONCIERGE_TICKETS_LOG", "/data/tickets.jsonl"))


def main() -> int:
    raw = sys.stdin.read()
    try:
        ctx = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        ctx = {"raw": raw}

    # Synthesize a unique ticket id. Was session+event+second-resolution time,
    # which collided on a same-second retry/flake; uuid makes it unique.
    basis = f"{ctx.get('session_id','')}|{ctx.get('event','')}|{uuid.uuid4().hex}"
    ticket_id = "INC-" + hashlib.sha1(basis.encode()).hexdigest()[:8].upper()

    row = {
        "ticket_id": ticket_id,
        "ts": time.time(),
        "event": ctx.get("event"),
        "session_id": ctx.get("session_id"),
        "summary": (ctx.get("output") or ctx.get("result") or "")[:280],
        "source": "concierge-command-hook",
    }

    try:
        TICKETS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with TICKETS_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
    except OSError as e:
        # abort_on_error is false in the config, but never crash the hook host regardless.
        sys.stderr.write(f"open_ticket: failed to write ticket: {e}\n")
        return 0

    sys.stdout.write(f"opened ticket {ticket_id}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
