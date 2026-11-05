import { appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  type ConfigInput,
  findConfigFile,
  MutationWorkflowError,
  type TargetConfigInput,
  writeConfigFile,
} from '@mutationworkflow/core';
import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { oneOf } from '../options.js';

export interface InitOptions {
  name?: string;
  kind?: 'web' | 'cli';
  baseUrl?: string;
  /** web: the command that starts the app; cli: the command under test. */
  command?: string;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

const OPTIONAL_SETTINGS = `
# Optional settings with their defaults; uncomment to change.
# Full reference: docs/configuration.md
#
# agents:
#   maxParallel: 3            # concurrent model calls across all agents
# execution:
#   parallel: 2               # concurrent workflow replays
#   screenshots: on-failure   # always | on-failure | never
# exploration:
#   maxWorkflows: 10
#   focus: []                 # areas the explorers should prioritise
# schedule:
#   cron:                     # used by "mw schedule"
#     - expression: "0 3 * * *"
#       action: cycle         # run | explore | mutate | cycle
`;

/** The minimal config `mw init` writes: the project and one target. */
export function buildInitConfig(rootDir: string, options: InitOptions = {}): ConfigInput {
  const kind = options.kind ?? 'web';
  let target: TargetConfigInput;
  if (kind === 'cli') {
    if (!options.command) {
      throw new MutationWorkflowError(
        'INVALID_INPUT',
        'A cli target needs --command, e.g. --command "node cli.js"',
      );
    }
    target = { id: 'cli', kind, options: { command: options.command, shell: true } };
  } else {
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    target = {
      id: 'web',
      kind,
      options: { baseUrl },
      ...(options.command
        ? { environment: { start: { command: options.command, ready: { url: baseUrl } } } }
        : {}),
    };
  }
  return {
    version: 1,
    project: { name: options.name ?? (basename(rootDir) || 'project') },
    targets: [target],
  };
}

/** Write the init config into `rootDir`; refuses when a config file already exists there. */
export function initProject(rootDir: string, options: InitOptions = {}): string {
  const existing = findConfigFile(rootDir);
  if (existing) {
    throw new MutationWorkflowError(
      'INVALID_INPUT',
      `${existing} already exists; edit it instead, or delete it to start over.`,
    );
  }
  const path = join(rootDir, 'mutationworkflow.config.yaml');
  const config = buildInitConfig(rootDir, options);
  writeConfigFile(path, config);
  const startHint =
    options.kind !== 'cli' && !options.command
      ? '\n# No environment.start: the app must already be running at the baseUrl.\n# Add one so MutationWorkflow starts (and stops) the app itself:\n#   environment:\n#     start: { command: "npm run dev", ready: { url: "http://127.0.0.1:3000" } }\n'
      : '';
  appendFileSync(path, `${startHint}${OPTIONAL_SETTINGS}`);
  return path;
}

export function registerInit(program: Command, cli: Cli): void {
  program
    .command('init')
    .description('Write a minimal, commented config with one target (no agents needed)')
    .option('--name <name>', 'project name (default: the directory name)')
    .option('--kind <kind>', 'target kind: web or cli', oneOf(['web', 'cli'] as const), 'web')
    .option('--base-url <url>', `web: base URL of the app (default ${DEFAULT_BASE_URL})`)
    .option('--command <cmd>', 'web: command that starts the app; cli: the command to test')
    .action((options: InitOptions) => {
      const path = initProject(cli.projectDir(), options);
      cli.output.out(`Wrote ${path}`);
      cli.output.err('Next: "mw doctor" to check the setup, then "mw explore" or "mw run".');
    });
}
