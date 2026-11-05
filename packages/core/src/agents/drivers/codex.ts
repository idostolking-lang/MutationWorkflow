import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDriveRequest, AgentDriveResult } from '../provider.js';
import {
  CliAgentDriver,
  type CliInvocation,
  type CliOutcome,
  outputTail,
  zeroUsage,
} from './cli-driver.js';

/**
 * Runs each agent task through the Codex command line (`codex exec`), using the user's own Codex
 * login or subscription. MutationWorkflow's tools reach it over MCP through a per-run config
 * override, and the final message is read from a temporary file. Codex has no separate system
 * prompt in non-interactive mode, so the instructions precede the task. Token usage is not
 * reported, so budgets in tokens or dollars do not apply to this driver.
 */
export class CodexDriver extends CliAgentDriver {
  readonly type = 'codex';

  protected async invocation(
    request: AgentDriveRequest,
    toolServerUrl: string,
  ): Promise<CliInvocation> {
    const lastMessage = join(tmpdir(), `mw-codex-${randomUUID()}.md`);
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-c',
      `mcp_servers.mw.url=${JSON.stringify(toolServerUrl)}`,
      '--output-last-message',
      lastMessage,
    ];
    if (request.model) args.push('--model', request.model);
    args.push(`${request.system}\n\n---\n\nTask:\n${request.task}`);
    return { args, tempFiles: [lastMessage] };
  }

  protected async parse(
    outcome: CliOutcome,
    _request: AgentDriveRequest,
    invocation: CliInvocation,
  ): Promise<AgentDriveResult> {
    const file = invocation.tempFiles?.[0];
    let text = '';
    if (file) {
      text = await readFile(file, 'utf8')
        .then((content) => content.trim())
        .catch(() => '');
    }
    if (!text)
      text =
        outcome.stdout
          .trim()
          .split(/\n\s*\n/)
          .at(-1)
          ?.trim() ?? '';
    if (outcome.code !== 0) {
      return {
        text,
        usage: zeroUsage(),
        turns: 0,
        stoppedBecause: 'error',
        error: `Codex exited with code ${outcome.code ?? outcome.signal}:\n${outputTail(outcome)}`,
      };
    }
    return { text, usage: zeroUsage(), turns: 0, stoppedBecause: 'finished' };
  }
}
