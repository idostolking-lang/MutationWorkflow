# 0007: One semaphore over model calls defines parallelism

Status: accepted

## Context

Users want to control how many agents run at once ("use up to 3 Opus agents at a time"), and
agents want to delegate sub-tasks to parallel sub-agents. Counting agents is ambiguous: a parent
waiting for its children is idle, and a sub-agent is as expensive as a top-level one.

## Decision

`agents.maxParallel` is the size of one semaphore that every model call, from any agent at any
depth, must acquire. Tool execution and waiting hold no permit. The `delegate` tool runs sub-tasks
through the same runtime, with a depth limit of two, so a parent and its delegates share the cap.

## Consequences

- The configured number is the maximum number of concurrent model requests, which is what rate
  limits and cost are about.
- Fan-out cannot deadlock: a parent holds no permit while it waits.
- Exploration parallelism (`exploration.parallelExplorers`) and workflow execution parallelism
  (`execution.parallel`) are separate settings, because they bound different resources (browser
  sessions and processes rather than model calls).
