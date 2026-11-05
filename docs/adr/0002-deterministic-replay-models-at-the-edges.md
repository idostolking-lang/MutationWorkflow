# 0002: Deterministic replay; models only at the edges

Status: accepted

## Context

Running agents around the clock against an application is expensive and non-deterministic. A bug
report nobody can reproduce is worthless, and a pipeline whose cost grows with every run is not
something teams keep enabled.

## Decision

Separate three phases. Discovery (inspecting the repository, exploring the application) and
triage (judging findings, writing titles and reproductions) use models. Replay does not: every
workflow, including every mutation, is a plain record that the executor performs step by step
through an adapter, with oracles that are ordinary code. Operators that derive mutations are pure
functions of the workflow and the adapter's hints.

## Consequences

- Replay is fast, cheap and reproducible, so it can run on every push and in a loop.
- Every finding carries an exact reproduction: the steps of the workflow that failed.
- Runs record the commit and branch, so a finding can be bisected.
- The expensive phases run only when there is something new to discover or judge, and their
  budgets are enforced per job.
