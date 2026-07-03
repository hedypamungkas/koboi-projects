"""healthcare_ext -- Riverside Family Clinic pre-visit patient intake extensions for koboi-agent.

Two pieces, both plain extensions (no changes to koboi core):

- `healthcare_ext.tools.flag_urgent_escalation` -- the only tool this app exposes,
  wired up via `tools.custom` in config/agent.yaml.
- `healthcare_ext.guardrails.PHIRedactionGuardrail` -- registered under the name
  "phi_redaction" via the `koboi.guardrails` entry point declared in this
  package's pyproject.toml.

Guardrail registration belt-and-suspenders: `koboi.plugins.discover_plugins()`
runs automatically at `import koboi` time and loads entry points from installed
package metadata -- reliable once `pip install -e .` has run (as the Dockerfile
does), which is our primary registration path. We additionally call
`guardrails.register()` here, in this package's own `__init__`, because
`tools.custom: [{module: healthcare_ext.tools}]` in agent.yaml always imports
`healthcare_ext.tools`, and importing any submodule of a package runs the
package's `__init__.py` first. That guarantees "phi_redaction" is registered
in `GuardrailRegistry` even in an environment where entry-point discovery has
friction (e.g. a plain `PYTHONPATH` import without a real package install) --
`GuardrailRegistry.register()` is idempotent (a plain dict assignment), so
calling it twice is harmless.
"""

from healthcare_ext.guardrails import register as _register_guardrails

_register_guardrails()
