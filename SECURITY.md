# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability" button on the
repository's Security tab, or by contacting the maintainers directly. Do not open a public issue
for a vulnerability. You should receive an acknowledgement within a few days.

## What to keep in mind when using MutationWorkflow

MutationWorkflow executes things on your behalf, so its configuration deserves the same care as
code:

- **The config file runs commands.** `environment.start` and `environment.reset` are executed
  through a shell from the project root. Review changes to `mutationworkflow.config.yaml` as you
  would review a build script, and never load a config from an untrusted source.
- **Agents act on a local instance only.** The tool starts the application itself or targets the
  localhost URL you configure. Keep it that way: do not point targets at production, and use
  `scope.denyText` and `scope.denyUrls` to fence off anything with real-world side effects even
  locally (payment providers, outgoing email).
- **Repository contents reach the model.** During `setup` the inspector reads files in the
  project (generated and vendored directories excluded) and sends excerpts to the configured
  model provider. Keep secrets out of the repository, or exclude their directories through
  `.gitignore`, which the inspector honours for plain directory entries.
- **API keys come from the environment.** Keys are read from the environment variables named in
  the config (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or your own). They are never written to the
  database, the reports or the logs.
- **Evidence may contain data.** Screenshots, console output and terminal transcripts are stored
  under `.mutationworkflow/evidence`. Treat that directory like test output: it is ignored by
  git by default, and you may want to exclude it from backups that leave your machine.
