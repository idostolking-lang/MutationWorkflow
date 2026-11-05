# 0010: Change-aware selection from what workflows learned they touch

Status: accepted

## Context

Memory grows with every exploration and mutation pass: a few dozen base workflows become
hundreds of variants, and replaying all of them on every push takes longer than the change
deserves. Most commits touch one area of the application, and most workflows never reach it.
To skip them safely, the engine has to know which workflows exercise which code, without
instrumenting the application, without a model in the loop (replay stays deterministic, see
[0002](0002-deterministic-replay-models-at-the-edges.md)) and without asking the team to
maintain a mapping by hand.

## Decision

Workflows learn what they touch from their own runs, and a change selects workflows by overlap.

1. **Footprints.** Adapters may report what a session exercised through an optional
   `AdapterSession.footprint()`: pages visited and endpoints or commands used. The web adapter
   records in-scope main-frame navigations, fetch and XHR calls and non-GET requests; the cli
   adapter records command words. Each run stores its footprint as `touched`.
2. **Learning.** After every recorded run the footprint is merged into the workflow's
   `touches`, and a variant's into its base too. A code map turns the accumulated pages and
   endpoints into files: explicit `targets[].codemap` rules, plus a search of the repository
   for files that mention each path's static prefix literally, with ids normalised away and
   results capped.
3. **Selection.** For a change (explicit files, or a git range defaulting to the commit of the
   last run up to `HEAD`), base workflows are impacted, unknown or unaffected. Impacted and
   unknown bases replay with all their variants. Everything replays when a shared file changed
   (manifests, lockfiles, build and global config, migrations), when no workflow is known to be
   unaffected, or when git cannot answer.

Selection only ever removes workflows that are known not to be affected; anything uncertain
runs.

## Alternatives considered

- **Coverage instrumentation.** Collecting server and browser coverage per run would map
  workflows to lines precisely. It needs a hook into every runtime and build (V8 coverage,
  Istanbul, coverage.py, JaCoCo), changes how the application is started, slows replay, and
  breaks with bundled or minified code. MutationWorkflow tests applications it starts as they
  are; it does not rebuild them.
- **Static call-graph analysis.** Resolving routes to handlers and handlers to their callees
  would work without running anything, but needs a parser and a framework model per language
  and router, and still misses dynamic dispatch, middleware and configuration-driven routing.
  The footprint is observed behaviour, which is what replay cares about.
- **Hand-written tags.** Letting people tag workflows with areas and files is simple but goes
  stale silently, and discovered and mutated workflows have no author to tag them. Explicit
  rules remain possible through `targets[].codemap`, but as a complement to learning.

## Consequences

- The literal-path search is a heuristic. A generic path such as `/api` or `/items` can match
  many files and over-select; per-path and per-workflow caps (25 and 60 files) bound that, and
  a codemap rule is the fix when it matters. Over-selection costs time, not correctness.
- It can also under-select: code that builds its paths at runtime, server-side logic reached
  without a request of its own (jobs, templates), or a change in a file no path mentions, such
  as a shared helper. Shared files and unknown workflows always run, and a full run (no
  `changed`) stays the default; scheduled or CI pipelines should still replay everything
  periodically.
- Adapters without `footprint()` keep working: their workflows are always unknown and always
  run.
- Learning lives in the memory. In CI the `.mutationworkflow` directory has to be restored
  before a change-aware run and saved after it; with a fresh database every workflow is
  unknown, everything runs, and the commit to diff from falls back to `HEAD~1`. Shallow clones
  may lack the last run's commit, in which case everything runs.
- Changed paths from git are made relative to the project directory and limited to it
  (`git diff --relative`), so a project in a subdirectory of its repository works and commits
  that only touch other directories count as no change for it.
- Runs and workflows gained fields (`touched`, `touches`) inside their JSON records, and `meta`
  gained `last-run-commit`; no migration was needed, and older records read as having touched
  nothing.
