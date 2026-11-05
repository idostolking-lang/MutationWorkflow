# 0004: Only local environments the tool starts itself

Status: accepted

## Context

Agents that explore an application will click everything they can reach. Against a shared
environment they would send real emails, charge cards and delete data.

## Decision

A target is a local application. The configuration says how to start it (command, ready check,
reset command) and the engine starts it for every run or exploration and stops it afterwards. A
target without a start command must be a localhost URL the operator already runs. Production is
never a target.

Within the local instance, scope rules fence agents further: allowed and denied URL patterns and
text patterns of controls that must never be activated. Prompts forbid actions with visible
real-world side effects even when the UI offers them.

## Consequences

- The environment manager is a core component, with readiness checks and process-group cleanup.
- Resetting state between runs is a first-class option, at the cost of serial execution.
- Teams whose application needs external services must provide local or stub versions; the
  inspector raises a question when it cannot find a self-contained start command.
