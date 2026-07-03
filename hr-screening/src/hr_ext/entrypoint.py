"""hr_ext/entrypoint -- process entrypoint that wires ScoringAuditHook into koboi.

`koboi serve <config>` (the bare CLI) has no YAML key or entry-point group for
custom hooks -- only tools/RAG/context support that (`tools.custom`,
`rag.custom_modules`, `context.custom_modules`). Hooks are wired via
`koboi.server.app.create_app(config, extra_hooks=[...])` instead, which means
this app needs its own small entrypoint rather than the bare `koboi serve`.

Verified against the installed koboi-agent==0.2.0 wheel
(`koboi/server/app.py::create_app`):

    def create_app(
        config: Config,
        *,
        client_factory: Callable[[], Any] | None = None,
        extra_tools: Sequence = (),
        extra_hooks: Sequence = (),
        approval_handler: Any | None = None,
        extra_middleware: Sequence = (),
        extra_routes: Sequence[ExtraRouteRegistrar] = (),
        workspace_root: str = "./workspace",
        cap: int = 100,
        enable_cors: bool = True,
        api_keys: list[str] | None = None,
    ) -> FastAPI: ...

`tools.custom` in `config/agent.yaml` is enough to register `fetch_resume` /
`score_candidate` (that path is handled by koboi's own facade regardless of how
the app is started); `extra_hooks` is the only piece this entrypoint has to add
by hand.

One more wrinkle found only by running this against the real wheel: passing a
bare `Hook` subclass *instance* in `extra_hooks` (as a naive reading of
`create_app(..., extra_hooks=[ScoringAuditHook()])` suggests) crashes at first
request with `TypeError: 'ScoringAuditHook' object is not subscriptable`.
`koboi.server.pool.AgentPool._build_agent` only understands two shapes for each
`extra_hooks` entry: a bare callable (wrapped via `agent.add_hook(cb)`, which
defaults to running on *every* `HookEvent` -- see `CallbackHook.__init__`), or
a `(callback, events)` tuple. `_as_extra_hook` below adapts our `Hook` subclass
to that tuple shape using its own `execute` bound method and `handles()` list,
so `ScoringAuditHook` still only fires on `POST_TOOL_USE` as declared.
"""

from __future__ import annotations

import logging
import os

import uvicorn

from koboi.config import Config
from koboi.hooks.chain import Hook
from koboi.server.app import create_app

from hr_ext.hooks import ScoringAuditHook

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

CONFIG_PATH = os.environ.get("HR_CONFIG_PATH", "config/agent.yaml")


def _as_extra_hook(hook: Hook) -> tuple:
    """Adapt a `Hook` ABC subclass to the `(callback, events)` shape AgentPool expects."""
    return (hook.execute, hook.handles())


def build_app():
    cfg = Config.from_yaml(CONFIG_PATH)
    return create_app(cfg, extra_hooks=[_as_extra_hook(ScoringAuditHook())])


app = build_app()


def main() -> None:
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))


if __name__ == "__main__":
    main()
