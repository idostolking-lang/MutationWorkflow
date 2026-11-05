import type { AgentDriveRequest, AgentDriveResult } from '../provider.js';
import {
  CliAgentDriver,
  type CliInvocation,
  type CliOutcome,
  outputTail,
  zeroUsage,
} from './cli-driver.js';

/** Shape of `claude -p --output-format json`; only the fields read here. */
interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
}

/**
 * Runs each agent task through the Claude Code command line in print mode, using the user's own
 * Claude Code login or subscription. MutationWorkflow's tools reach it over MCP; built-in tools
 * are switched off except for the inspector, which keeps read-only access to the repository and
 * is better served by Claude Code's own file tools than by ours.
 */
export class ClaudeCodeDriver extends CliAgentDriver {
  readonly type = 'claude-code';

  protected async invocation(
    request: AgentDriveRequest,
    toolServerUrl: string,
  ): Promise<CliInvocation> {
    const mcpConfig = JSON.stringify({ mcpServers: { mw: { type: 'http', url: toolServerUrl } } });
    const args = [
      '-p',
      request.task,
      '--output-format',
      'json',
      '--system-prompt',
      request.system,
      '--mcp-config',
      mcpConfig,
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__mw',
      '--no-session-persistence',
    ];
    if (request.role === 'inspector') {
      args.push('--restricted');
    } else {
      args.push('--tools', '');
    }
    if (request.model) args.push('--model', request.model);
    return { args };
  }

  protected async parse(
    outcome: CliOutcome,
    _request: AgentDriveRequest,
  ): Promise<AgentDriveResult> {
    const parsed = parseJsonObject(outcome.stdout);
    if (!parsed) {
      return {
        text: '',
        usage: zeroUsage(),
        turns: 0,
        stoppedBecause: 'error',
        error: `Claude Code exited with code ${outcome.code ?? outcome.signal} without a JSON result:\n${outputTail(outcome)}`,
      };
    }
    const usage = parsed.usage ?? {};
    const model = parsed.modelUsage ? Object.keys(parsed.modelUsage)[0] : undefined;
    const result: AgentDriveResult = {
      text: parsed.result ?? '',
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
      costUsd: parsed.total_cost_usd,
      turns: parsed.num_turns ?? 0,
      stoppedBecause: 'finished',
      model,
    };
    if (parsed.subtype?.includes('max_turns')) {
      result.stoppedBecause = 'max-turns';
    } else if (parsed.is_error || (outcome.code !== 0 && outcome.code !== null)) {
      result.stoppedBecause = 'error';
      result.error =
        parsed.result ||
        `Claude Code reported ${parsed.subtype ?? 'an error'}:\n${outputTail(outcome)}`;
    }
    return result;
  }
}

/** The JSON object printed last on stdout; Claude Code may print warnings before it. */
function parseJsonObject(stdout: string): ClaudeJsonResult | undefined {
  const trimmed = stdout.trim();
  const start = trimmed.lastIndexOf('\n{');
  const candidate = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  try {
    const value = JSON.parse(candidate) as unknown;
    return value && typeof value === 'object' ? (value as ClaudeJsonResult) : undefined;
  } catch {
    return undefined;
  }
}
