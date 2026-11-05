# 0001: Mutate user workflows, not code

Status: accepted

## Context

Most production bugs that escape a well-tested application are not in the features themselves but
in the sequences and states nobody enumerated: a step repeated, two steps swapped, a flow
interrupted and resumed, unusual input, a different role. Test suites check the paths their
authors imagined. Fuzzers and monkey testers explore sequences but understand nothing about the
application; model-based testing understands sequences but needs a hand-written model.

## Decision

The unit of work is the workflow: an ordered list of user actions with an intent. Agents infer the
model of the application by discovering workflows; deterministic operators derive variants of them;
the variants are replayed against the application. We call the variants mutations.

We use the word deliberately and define it early in every document: classic mutation testing
mutates code to test the tests; MutationWorkflow mutates workflows to test the application.

## Consequences

- Workflows must be fully serialisable and replayable without a model, which drives the adapter
  design (an explicit action and assertion vocabulary per kind of application).
- Operators are the cheap, deterministic heart of the method; agents are the expensive source of
  new workflows and of judgement.
- Users of mutation-testing tools may expect something else; the README and docs address it.
