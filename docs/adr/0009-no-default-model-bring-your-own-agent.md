# 0009: No default model; bring your own agent

Status: accepted (supersedes the model-default consequence in 0003)

## Context

Early versions assumed an API key and picked a model when none was configured. That contradicts
how people actually run coding agents today: they already pay for Claude Code, Codex or Cursor,
they choose models there, and they do not want a second account or a second opinion on which
model is best. A default also ages badly and quietly decides cost on the user's behalf.

## Decision

MutationWorkflow never chooses a model. Agent roles can be run three ways, and the user picks:

1. **The connected coding agent itself.** Over MCP, the client asks for a brief (instructions,
   context, result schema) for setup, exploration, triage or mutation, does the thinking with
   whatever model it runs, and submits the result through fine-grained tools. No API key.
2. **The coding agent's command line as a driver.** A provider of type `claude-code` or `codex`
   runs each task through `claude -p` or `codex exec` with the user's installation and
   subscription. MutationWorkflow serves the task's tools to it over an ephemeral loopback MCP
   server. A model name is optional and passed through; otherwise the tool's own setting applies.
3. **A model API.** A provider of type `anthropic` or `openai` with a key from the environment and
   a model id the user names per role or in `agents.defaults.model`. Missing model: a clear error.

When nothing is configured, whatever is available is offered (API keys in the environment,
coding-agent command lines on PATH). When several are available, the configuration must name one.

## Consequences

- The runtime has two provider kinds: per-turn model providers, for which MutationWorkflow owns
  the tool loop, and whole-task drivers, which own their own loop and call the same tools.
- Every role is split into a brief and an apply step, shared by all three ways of running it.
- Documentation never shows a model id as a default, only as an example the user might choose.
- Autonomous modes (cron, continuous, CI) need a driver or an API provider, since no client is
  attached; interactive use needs nothing beyond the coding agent already open.
