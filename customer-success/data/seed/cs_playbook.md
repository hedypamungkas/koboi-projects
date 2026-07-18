# Customer-Success Playbook (demo seed)

> Lightweight reference the CSM-facing analyst follows. Fictional. (Not wired as RAG by default;
> the account data lives in `cs_ext.tools`.)

## Risk levels and the right action

- **Low (score < 30):** healthy. Action: `maintain`. Keep the cadence; no outreach needed.
- **Medium (30-54):** watch. Action: `check_in`. A proactive, value-led check-in before renewal.
- **High (>= 55):** at-risk. Action: `escalate_to_csm` or `schedule_qbr`. If renewal is near
  (<60d) and signals are dark, `flag_at_risk` for an immediate warm hand-off.

## What "act before renewal" means

A declining-usage account with renewal under 60 days out is the highest-leverage intervention
window. Prioritize an executive sponsor check-in + a QBR over a generic nurture email.

## Outreach tone

- Lead with the customer's outcome, not our product.
- One ask per message.
- Never promise roadmap or commercial terms the CSM hasn't approved (draft_outreach pauses for
  approval precisely so a human owns what's sent).
