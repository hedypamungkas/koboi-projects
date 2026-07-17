"""healthcare_ext/guardrails.py -- PHIRedactionGuardrail.

koboi's built-in output guardrail (`guardrails.output: {detect_sensitive: true}`,
implemented by koboi.guardrails.output.OutputGuardrail / registry name
"content_filter") catches API keys, passwords, and card numbers. It does not
catch phone numbers, dates of birth, or insurance-ID-looking strings -- those
aren't secrets in the pattern-matching sense, but they are PHI. This guardrail
fills that gap.

Design notes (see README "Guardrails" section for the full writeup):

- Subclasses `PatternGuardrail` (koboi.guardrails.base) per the base class
  contract: override `PATTERNS`/`DEFAULT_ACTION`, reuse `check_patterns()`.
- `koboi/config_models.py`'s `GuardrailsConfig.output` field is typed as a
  single `OutputGuardrailConfig` object (verified empirically: passing a list
  there raises a pydantic ValidationError at config load, so the *list* of
  guardrail names shown in docs/04 -- `output: [phi_redaction]` -- does not
  validate against the actual schema). Only one dict-shaped guardrail block
  fits in the `output` slot. To avoid losing the built-in secret-leak
  detector, this guardrail optionally folds in `OutputGuardrail.PATTERNS`
  when constructed with `detect_sensitive=True` (see `agent.yaml`'s
  `guardrails.output: {name: phi_redaction, detect_sensitive: true}`) -- one
  guardrail instance, two responsibilities.
- `DEFAULT_ACTION = "warn"`, matching the built-in `OutputGuardrail`. A
  `block`/`deny`/`abort` action would raise `AgentGuardrailError` and end the
  SSE stream with an `error` event instead of a message -- too aggressive for
  a demo running regexes over a patient's free-text symptom answers, where a
  false positive would otherwise deny the whole reply.
"""

from __future__ import annotations

import re

from koboi.guardrails.base import PatternGuardrail
from koboi.types import GuardrailResult

# Deliberately narrow, illustrative patterns for a demo -- not a production-grade
# PHI detector (no NLP/NER, no international phone/ID formats).
PHI_PATTERNS: list[tuple[str, str]] = [
    (
        r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b",
        "Possible phone number",
    ),
    (
        r"\b(0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])[/-](19|20)\d{2}\b",
        "Possible date of birth (MM/DD/YYYY)",
    ),
    (
        r"\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b",
        "Possible date of birth (YYYY-MM-DD)",
    ),
    (
        # The id/number word and a digit somewhere in the token are both
        # required -- without them this matched ordinary phrases like
        # "insurance company" or "policy holder" (the label word followed by
        # any 6-15 char word), which is exactly the kind of thing patients say
        # unprompted in an intake conversation.
        r"(?i)\b(?:member|policy|insurance)\s+(?:id|no\.?|number|#)\s*[:#]?\s*(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{5,15}\b",
        "Possible insurance ID",
    ),
]


class PHIRedactionGuardrail(PatternGuardrail):
    """Flags phone numbers, dates of birth, and insurance-ID-looking strings.

    Note on "redaction": `GuardrailResult.sanitized_content` is populated with
    a regex-redacted version of the content, but koboi's current output
    pipeline (`AgentCore._process_output` in koboi/loop.py) does not consume
    `sanitized_content` -- it only branches on `action` (block vs. warn). A
    "warn" result gets a `[GUARDRAIL WARNING ...]` banner prepended to the
    *stored* assistant message and the final `complete` SSE event's content;
    it does NOT retroactively redact text already streamed as `text_delta`
    events (streaming happens token-by-token before the full response is
    guardrail-checked). See README for why this is an acceptable, documented
    limitation for this demo rather than something this guardrail can fix on
    its own.
    """

    PATTERNS: list[tuple[str, str]] = PHI_PATTERNS
    DEFAULT_ACTION = "warn"

    def __init__(self, detect_sensitive: bool = False, **kwargs: object) -> None:
        patterns = list(self.PATTERNS)
        if detect_sensitive:
            from koboi.guardrails.output import OutputGuardrail

            patterns = list(OutputGuardrail.PATTERNS) + patterns
        kwargs.pop("patterns", None)
        kwargs.pop("default_action", None)
        super().__init__(patterns=patterns, default_action=self.DEFAULT_ACTION, **kwargs)

    async def check(self, content: str, context: list[str] | None = None) -> GuardrailResult:
        # ``context`` (the retrieved RAG chunk strings, output path only) was added to
        # ``BaseGuardrail.check`` in koboi 0.18.x -- the caller now passes it as a kwarg,
        # so every override MUST accept it (a bare ``check(self, content)`` raises
        # TypeError and ends the stream with an ``error`` event). This guardrail redacts
        # the model's *output* for PHI, so ``context`` isn't used here -- it just has to
        # be in the signature to satisfy the base contract.
        if not content:
            return GuardrailResult(passed=True)

        result = await self.check_patterns(content)
        if result is not None:
            return GuardrailResult(
                passed=False,
                reason=result.reason,
                action=result.action,
                sanitized_content=self._redact(content),
            )
        return GuardrailResult(passed=True)

    def _redact(self, content: str) -> str:
        redacted = content
        for pattern, _description in self.patterns:
            redacted = re.sub(pattern, "[REDACTED]", redacted)
        return redacted


def register() -> None:
    """Entry point target: `koboi.guardrails` -> `phi_redaction`.

    Called automatically by `koboi.plugins.discover_plugins()` at `import koboi`
    time once this package is installed (see pyproject.toml). Also called
    directly from `healthcare_ext/__init__.py` as a fallback -- see that
    module's docstring and the README for why.
    """
    from koboi.guardrails.registry import GuardrailRegistry

    GuardrailRegistry.register("phi_redaction", lambda **kw: PHIRedactionGuardrail(**kw))
