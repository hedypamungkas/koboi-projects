---
name: indemnification-clauses
description: Acceptable and unacceptable indemnification (indemnify, indemnifies) clause variants, with fallback language
disable-model-invocation: false
---
# Indemnification Clauses

## Acceptable variants
- Mutual indemnification, capped at total fees paid under the contract
- One-sided indemnification that is capped and limited to third-party IP-infringement claims

## Unacceptable variants (propose the fallback redline below)
- Uncapped or one-sided indemnification
- Indemnification that extends to a party's own gross negligence or willful misconduct being
  indemnified by the *other* party
- Indemnification obligations that survive termination indefinitely (no time limit)

For any variant here, call the `propose_redline` tool with the fallback language below (it pauses for
lawyer approval before drafting the redline). Use `flag_novel_clause` only when NO playbook category
matches the clause at all.

## Fallback language
"Each party indemnifies the other for third-party claims arising from its own breach or
negligence, capped at the fees paid in the preceding twelve months."
