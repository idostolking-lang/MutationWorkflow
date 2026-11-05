import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type Config,
  Engine,
  errorMessage,
  findExecutable,
  type ResolvedConfig,
  silentLogger,
} from '@mutationworkflow/core';
import type { Command } from 'commander';
import type { Colors } from 'picocolors/types.js';
import type { Cli } from '../context.js';
import { BUILTIN_ADAPTERS, bootstrapConfig, loadProjectConfig } from '../engine-factory.js';
import { ExitCode } from '../errors.js';
import { plain } from '../format.js';

export type CheckState = 'ok' | 'warn' | 'fail';

export interface Check {
  state: CheckState;
  label: string;
  detail?: string;
}

const MIN_NODE = [22, 13] as const;

/** Whether `version` ("22.14.0") is at least `minimum`. */
export function nodeVersionOk(version: string, minimum: readonly [number, number] = MIN_NODE) {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

/** API-key checks for configured providers, or for the inferred ones when none are configured. */
/** Which model providers can be used: API keys for API providers, installed CLIs for drivers. */
export function providerChecks(config: Config, env: NodeJS.ProcessEnv): Check[] {
  const entries = Object.entries(config.providers);
  if (entries.length === 0) {
    const available = [
      ...['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
        .filter((name) => env[name])
        .map((name) => `${name} set`),
      ...(findExecutable('claude', env) ? ['Claude Code CLI installed'] : []),
      ...(findExecutable('codex', env) ? ['Codex CLI installed'] : []),
    ];
    return [
      available.length > 0
        ? { state: 'ok', label: 'Model provider', detail: available.join(', ') }
        : {
            state: 'warn',
            label: 'Model provider',
            detail:
              'none available: install Claude Code or Codex, or set ANTHROPIC_API_KEY or OPENAI_API_KEY; setup, explore, triage and mutate --agent are unavailable',
          },
    ];
  }
  return entries.map(([id, provider]): Check => {
    if (provider.type === 'anthropic' || provider.type === 'openai') {
      return env[provider.apiKeyEnv]
        ? { state: 'ok', label: `Provider ${id}`, detail: `${provider.apiKeyEnv} set` }
        : { state: 'fail', label: `Provider ${id}`, detail: `${provider.apiKeyEnv} is not set` };
    }
    const isPath = provider.command.includes('/') || provider.command.includes('\\');
    const found = isPath
      ? existsSync(provider.command)
      : Boolean(findExecutable(provider.command, env));
    return found
      ? { state: 'ok', label: `Provider ${id}`, detail: `${provider.command} found` }
      : {
          state: 'fail',
          label: `Provider ${id}`,
          detail: `${provider.command} is not installed or not on PATH`,
        };
  });
}

/** Resolve and load Playwright the way the web adapter would: from the project, then from it. */
async function playwrightCheck(rootDir: string): Promise<Check> {
  const bases = [join(rootDir, 'package.json')];
  try {
    bases.push(fileURLToPath(import.meta.resolve('@mutationworkflow/adapter-web')));
  } catch {
    // The adapter is a dependency of this package; resolution only fails in broken installs.
  }
  for (const base of bases) {
    let resolved: string;
    try {
      resolved = createRequire(base).resolve('playwright');
    } catch {
      continue;
    }
    try {
      const module: unknown = await import(pathToFileURL(resolved).href);
      const executable = chromiumExecutable(module);
      if (executable && !existsSync(executable)) {
        return {
          state: 'fail',
          label: 'Playwright',
          detail: 'Chromium is not installed; run "npx playwright install --with-deps chromium"',
        };
      }
      return { state: 'ok', label: 'Playwright', detail: resolved };
    } catch (error) {
      return { state: 'fail', label: 'Playwright', detail: errorMessage(error) };
    }
  }
  return {
    state: 'fail',
    label: 'Playwright',
    detail:
      'not installed; run "npm i -D playwright && npx playwright install --with-deps chromium"',
  };
}

function chromiumExecutable(module: unknown): string | undefined {
  if (!module || typeof module !== 'object' || !('chromium' in module)) return undefined;
  const { chromium } = module;
  if (!chromium || typeof chromium !== 'object' || !('executablePath' in chromium))
    return undefined;
  const { executablePath } = chromium;
  if (typeof executablePath !== 'function') return undefined;
  try {
    const path: unknown = executablePath.call(chromium);
    return typeof path === 'string' ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Run every environment check for the project in `projectDir`. */
export async function runDoctor(options: {
  projectDir: string;
  configPath?: string;
  env: NodeJS.ProcessEnv;
}): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(
    nodeVersionOk(process.versions.node)
      ? { state: 'ok', label: 'Node.js', detail: process.versions.node }
      : {
          state: 'fail',
          label: 'Node.js',
          detail: `${process.versions.node}; ${MIN_NODE.join('.')} or newer is required`,
        },
  );

  let resolved: ResolvedConfig;
  try {
    resolved = loadProjectConfig({ cwd: options.projectDir, configPath: options.configPath });
    checks.push({ state: 'ok', label: 'Config', detail: resolved.path });
  } catch (error) {
    checks.push({ state: 'fail', label: 'Config', detail: errorMessage(error) });
    resolved = bootstrapConfig(options.projectDir);
  }
  const { config } = resolved;

  let engine: Engine | undefined;
  try {
    engine = await Engine.create({
      config: resolved,
      logger: silentLogger,
      adapters: { ...BUILTIN_ADAPTERS },
      env: options.env,
      providers: new Map(),
    });
    checks.push({
      state: 'ok',
      label: 'Database',
      detail: resolved.resolvePath(config.store.path),
    });
  } catch (error) {
    checks.push({ state: 'fail', label: 'Database', detail: errorMessage(error) });
  }

  try {
    for (const target of config.targets) {
      const adapter = target.adapter ?? target.kind;
      if (engine) {
        try {
          await engine.registry.forTarget(target);
          checks.push({ state: 'ok', label: `Target ${target.id}: adapter`, detail: adapter });
        } catch (error) {
          checks.push({
            state: 'fail',
            label: `Target ${target.id}: adapter`,
            detail: errorMessage(error),
          });
        }
      }
      const start = target.environment.start;
      checks.push(
        start
          ? { state: 'ok', label: `Target ${target.id}: start command`, detail: start.command }
          : {
              state: 'warn',
              label: `Target ${target.id}: start command`,
              detail: 'none configured; the app must already be running',
            },
      );
    }
  } finally {
    await engine?.close();
  }

  if (config.targets.some((t) => (t.adapter ?? t.kind) === 'web')) {
    checks.push(await playwrightCheck(resolved.rootDir));
  }
  checks.push(...providerChecks(config, options.env));
  return checks;
}

/** `✓ Label  detail`, with ✗ for failures and ! for warnings. */
export function formatCheck(check: Check, colors: Colors = plain): string {
  const mark =
    check.state === 'ok'
      ? colors.green('✓')
      : check.state === 'warn'
        ? colors.yellow('!')
        : colors.red('✗');
  return `${mark} ${check.label}${check.detail ? `  ${colors.dim(check.detail)}` : ''}`;
}

export function registerDoctor(program: Command, cli: Cli): void {
  program
    .command('doctor')
    .description('Check Node, config, adapters, Playwright, API keys, database and environments')
    .action(async () => {
      const checks = await runDoctor({
        projectDir: cli.projectDir(),
        configPath: cli.globals().config,
        env: cli.env,
      });
      for (const check of checks) cli.output.out(formatCheck(check, cli.output.colors));
      if (checks.some((check) => check.state === 'fail')) cli.exitCode = ExitCode.error;
    });
}
