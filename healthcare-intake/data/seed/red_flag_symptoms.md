# Riverside Family Clinic -- Red-Flag Symptom Guidance (DEMO CONTENT)

> This is fictional, illustrative content written for a software demo. It is
> **not real clinical guidance** and must never be used to make an actual care
> decision. In a real deployment this document would be authored and
> maintained by Riverside's own clinical staff.

## Purpose

During pre-visit intake, compare what the patient describes against the
combinations below. If a combination matches, call `flag_urgent_escalation`
with a short reason right away, and tell the patient to seek immediate
in-person or emergency care. Otherwise, keep collecting intake information
normally -- most symptoms are routine and do not need escalation.

## Combinations that require immediate escalation

- Chest pain **and** shortness of breath, lasting more than a few minutes
- Sudden weakness or numbness on one side of the face, arm, or leg **and**
  slurred or garbled speech (demo "FAST" stroke check)
- Difficulty breathing **and** swelling of the face, lips, tongue, or throat
  (possible severe allergic reaction)
- High fever **and** a stiff neck **and** confusion or unusual drowsiness
- Any mention of thoughts of self-harm or suicide, regardless of the stated
  reason for the visit
- Heavy bleeding that has not slowed after direct pressure for several
  minutes

## Routine symptoms -- do NOT escalate

Ordinary, self-limited complaints -- a mild cough, a low-grade fever lasting
a few days, a scraped knee, seasonal allergy symptoms, mild fatigue -- are
summarized for the doctor as part of the normal pre-visit note. Escalation is
reserved for the combinations above. Do not flag routine descriptions "just
in case"; over-flagging defeats the purpose of a review queue a human is
actually watching.

## What escalation does and does not do

Calling `flag_urgent_escalation` only adds the conversation to a queue a
nurse checks. It does not page anyone, does not write to the patient's
record, and does not replace calling emergency services for a
life-threatening situation -- always tell the patient to call emergency
services themselves if what they describe sounds life-threatening.
