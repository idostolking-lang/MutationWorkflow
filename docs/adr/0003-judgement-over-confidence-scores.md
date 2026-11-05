# 0003: Judgement by a strong model and humans instead of confidence scores

Status: accepted

## Context

Deciding whether an unexpected outcome is a bug is the hard part of automated exploration (the
oracle problem). One answer is to attach confidence scores to findings and let users filter. That
produces a second system to tune, numbers nobody trusts, and a long tail of noise.

## Decision

No confidence scores. Instead:

- Oracles only report facts: a crash, an error response, a failed expectation, a broken invariant,
  a step that could not be performed. Each fact has a stable signature.
- A blocked step on a mutated workflow is not a finding: the application refused an out-of-order
  action, which is correct.
- Findings start with a mechanical title and `triage: pending`. A triager agent running a strong
  model reads the evidence and decides bug, not a bug, or needs a human, writing the title,
  reproduction, severity and rationale. Expected consequences of a mutation are dismissed.
- What the agent cannot judge becomes a question for the team, as does every behaviour an explorer
  observed that no test confirms. Answers activate workflows, archive them, or record bugs.
- Existing end-to-end tests are the preferred seed, because they encode intended behaviour.

## Consequences

- Findings have one severity and one verdict, both explained in words.
- Without a model provider, findings keep their mechanical titles and are marked `skipped` for
  triage; the deterministic pipeline still works.
- Quality depends on the triager model; the default is the strongest generally available model.
