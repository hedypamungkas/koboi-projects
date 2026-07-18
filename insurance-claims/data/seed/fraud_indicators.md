# Beacon Mutual SIU -- Fraud Indicator Protocol (demo)

> Demo seed document for the `fraud_screen` triage node's RAG. Fictional and simplified.

A claim is scored **low / medium / high** fraud risk by counting the indicators present.
This screen routes claims for review -- it does not accuse anyone of fraud.

## Indicators (each present indicator adds weight)

1. **Late reporting.** The loss was reported more than 72 hours after the incident without
   a credible reason. (Weight: medium.)
2. **Pre-existing damage.** The adjuster or estimator notes damage that appears to predate
   the reported loss date. (Weight: medium.)
3. **No independent witness / third party.** A single-vehicle loss or a "hit while parked,
   no third party" loss with no independent corroboration. Common, but warrants review.
   (Weight: low.)
4. **Loss type inconsistent with damage.** The described damage pattern does not match the
   reported cause of loss. (Weight: high.)
5. **Recently added coverage.** The relevant coverage was added within 30 days before the
   loss date. (Weight: high.)
6. **Prior similar claims.** The policyholder has filed a similar claim in the prior 12
   months. (Weight: medium.)

## Scoring rubric

- **low**: zero indicators, or only the "no independent witness" indicator.
- **medium**: exactly one medium/high indicator, or two low indicators.
- **high**: any two of {late reporting, pre-existing damage, inconsistent damage, recently
  added coverage, prior similar claims}, or any single high indicator alongside another.

## Routing rule

- A **medium** or **high** fraud-risk claim is never eligible for an automated settlement
  recommendation -- the `decide` node must route it to a human adjuster via
  `transfer_to_human`, citing the indicators present.
- A **low** fraud-risk claim may be recommended for settlement if it is also covered and
  low value.
