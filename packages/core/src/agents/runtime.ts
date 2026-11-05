import { z } from 'zod';
import type { AgentRole, AgentsConfig, Effort } from '../config/schema.js';
import { nowIso } from '../schema/common.js';
import type { Store } from '../store/types.js';
import { errorMessage, MutationWorkflowError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { Semaphore } from '../util/semaphore.js';
import { truncate } from '../util/text.js';
import {
  type AgentMessage,
  addUsage,
  type ContentPart,
  emptyUsage,
  type ImagePart,
  type ModelProvider,
  type TextPart,
  type TokenUsage,
  type ToolResultPart,
  type ToolUsePart,
  textOf,
  toolUsesOf,
} from './provider.js';
import {
  type AgentTool,
  defineTool,
  type ToolContext,
  type ToolOutput,
  toToolSpec,
} from './tools.js';

/** Fully resolved model settings for one role. */
export interface ResolvedModel {
  provider: ModelProvider;
  model: string;
  maxTurns: number;
  maxTokens: number;
  effort?: Effort;
  vision: boolean;
}

export type AgentEvent =
  | { type: 'turn'; role: AgentRole; depth: number; turn: number; usage: TokenUsage }
  | { type: 'tool'; role: AgentRole; depth: number; name: string; ok: boolean; summary: string }
  | { type: 'text'; role: AgentRole; depth: number; text: string };

export interface AgentRunOptions<T> {
  role: AgentRole;
  system: string;
  /** The task, sent as the first user message. */
  task: string;
  /** Images attached to the task (only sent when the role has vision enabled). */
  images?: ImagePart[];
  tools: AgentTool[];
  /** When set, the agent must call `finish` with a value matching this schema. */
  output?: z.ZodType<T>;
  jobId?: string;
  depth?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** Offer the delegate tool (default true). Off for agents whose tools are bound to one live session. */
  delegate?: boolean;
}

export type StopCause = 'finished' | 'max-turns' | 'budget' | 'refusal' | 'aborted' | 'error';

export interface AgentRunResult<T> {
  output: T | undefined;
  /** The agent's final free-text answer (empty when it finished through `finish`). */
  text: string;
  turns: number;
  usage: TokenUsage;
  costUsd: number;
  stoppedBecause: StopCause;
  error?: string;
}

export interface AgentRuntimeOptions {
  providers: ReadonlyMap<string, ModelProvider>;
  config: AgentsConfig;
  store?: Store;
  logger: Logger;
}

const DEFAULTS = { maxTurns: 60, maxTokens: 16_000 } as const;
const MAX_DELEGATION_DEPTH = 2;
const MAX_TOOL_OUTPUT_CHARS = 40_000;

interface JobSpend {
  usage: TokenUsage;
  costUsd: number;
}

/**
 * Runs agents: a model, a system prompt, a task and a set of tools, looped until the model
 * stops calling tools or calls `finish`. One semaphore caps concurrent model calls across every
 * agent and sub-agent, which is what "use up to 3 agents at a time" means in practice. Agents
 * can fan out through the `delegate` tool; a waiting parent holds no permit.
 */
export class AgentRuntime {
  readonly slots: Semaphore;
  private readonly spend = new Map<string, JobSpend>();

  constructor(private readonly options: AgentRuntimeOptions) {
    this.slots = new Semaphore(options.config.maxParallel);
  }

  /** Merge role settings over defaults and pick the provider and model. */
  resolveModel(role: AgentRole): ResolvedModel {
    const settings = { ...this.options.config.defaults, ...this.options.config.roles[role] };
    const provider = this.pickProvider(settings.provider);
    const model = settings.model ?? provider.defaultModel;
    if (!model) {
      throw new MutationWorkflowError(
        'PROVIDER_NOT_CONFIGURED',
        `No model configured for role "${role}" on provider "${provider.id}". Set agents.defaults.model or agents.roles.${role}.model.`,
      );
    }
    return {
      provider,
      model,
      maxTurns: settings.maxTurns ?? DEFAULTS.maxTurns,
      maxTokens: settings.maxTokens ?? DEFAULTS.maxTokens,
      effort: settings.effort,
      vision: settings.vision ?? provider.supportsVision,
    };
  }

  /** True when at least one provider is available, i.e. agents can run at all. */
  get enabled(): boolean {
    return this.options.providers.size > 0;
  }

  /** Tokens and cost spent so far on a job. */
  jobSpend(jobId: string): JobSpend {
    return this.spend.get(jobId) ?? { usage: emptyUsage(), costUsd: 0 };
  }

  /**
   * The `delegate` tool lets an agent hand independent sub-tasks to parallel sub-agents that
   * share its tools (minus `delegate` once the depth limit is reached).
   */
  delegateTool(parent: {
    role: AgentRole;
    system: string;
    tools: AgentTool[];
    jobId?: string;
    depth: number;
    signal?: AbortSignal;
    onEvent?: (event: AgentEvent) => void;
  }): AgentTool | undefined {
    if (parent.depth >= MAX_DELEGATION_DEPTH) return undefined;
    const maxTasks = Math.max(2, this.options.config.maxParallel * 2);
    return defineTool({
      name: 'delegate',
      description: `Run independent sub-tasks in parallel with sub-agents that have the same tools as you (at most ${this.options.config.maxParallel} model calls run at a time across all agents). Use it to split large investigations by area; give each sub-task full context since sub-agents do not see this conversation. Returns each sub-agent's final report.`,
      schema: z.object({
        tasks: z
          .array(
            z.object({
              title: z.string().min(1).describe('Short label used in the result'),
              task: z.string().min(1).describe('Complete, self-contained instructions'),
            }),
          )
          .min(1)
          .max(maxTasks),
      }),
      execute: async ({ tasks }) => {
        const results = await Promise.all(
          tasks.map((item) =>
            this.run({
              role: parent.role,
              system: parent.system,
              task: item.task,
              tools: parent.tools,
              jobId: parent.jobId,
              depth: parent.depth + 1,
              signal: parent.signal,
              onEvent: parent.onEvent,
            }).then(
              (result) => ({ item, result }),
              (error: unknown) => ({ item, error: errorMessage(error) }),
            ),
          ),
        );
        const report = results
          .map((entry) => {
            if ('error' in entry) return `## ${entry.item.title}\nFailed: ${entry.error}`;
            const { result } = entry;
            const body = result.text || `(no text; stopped because ${result.stoppedBecause})`;
            return `## ${entry.item.title}\n${body}`;
          })
          .join('\n\n');
        return { content: report };
      },
    });
  }

  async run<T>(options: AgentRunOptions<T>): Promise<AgentRunResult<T>> {
    const depth = options.depth ?? 0;
    const resolved = this.resolveModel(options.role);
    const log = this.options.logger.child(`${options.role}${depth ? `@${depth}` : ''}`);
    const tools = [...options.tools];
    const delegate =
      options.delegate === false
        ? undefined
        : this.delegateTool({ ...options, depth, tools: options.tools });
    if (delegate && !tools.some((tool) => tool.name === 'delegate')) tools.push(delegate);

    let finished: { value: T } | undefined;
    if (options.output) {
      const outputSchema = options.output;
      tools.push(
        defineTool({
          name: 'finish',
          description: 'Submit your final result. Call this exactly once when you are done.',
          schema: z.object({ result: outputSchema }),
          execute: async ({ result }) => {
            finished = { value: result as T };
            return { content: 'Result recorded.' };
          },
        }),
      );
    }
    const specs = tools.map(toToolSpec);
    const toolContext: ToolContext = {
      role: options.role,
      depth,
      jobId: options.jobId,
      logger: log,
      signal: options.signal,
    };

    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: options.task },
          ...(resolved.vision ? (options.images ?? []) : []),
        ],
      },
    ];
    let usage = emptyUsage();
    let costUsd = 0;
    let nudged = false;

    for (let turn = 1; turn <= resolved.maxTurns; turn++) {
      if (options.signal?.aborted) {
        return {
          output: undefined,
          text: '',
          turns: turn - 1,
          usage,
          costUsd,
          stoppedBecause: 'aborted',
        };
      }
      const budgetError = this.checkBudget(options.jobId);
      if (budgetError) {
        log.warn(budgetError);
        return {
          output: undefined,
          text: '',
          turns: turn - 1,
          usage,
          costUsd,
          stoppedBecause: 'budget',
          error: budgetError,
        };
      }

      let response: Awaited<ReturnType<ModelProvider['complete']>>;
      try {
        response = await this.slots.use(() =>
          resolved.provider.complete({
            model: resolved.model,
            system: options.system,
            messages,
            tools: specs,
            maxTokens: resolved.maxTokens,
            effort: resolved.effort,
            signal: options.signal,
          }),
        );
      } catch (error) {
        const message = errorMessage(error);
        log.error(`Model call failed: ${message}`);
        return {
          output: undefined,
          text: '',
          turns: turn - 1,
          usage,
          costUsd,
          stoppedBecause: 'error',
          error: message,
        };
      }

      usage = addUsage(usage, response.usage);
      const callCost = resolved.provider.estimateCostUsd(response.model, response.usage) ?? 0;
      costUsd += callCost;
      await this.recordUsage(
        options.jobId,
        options.role,
        resolved,
        response.model,
        response.usage,
        callCost,
      );
      options.onEvent?.({ type: 'turn', role: options.role, depth, turn, usage: response.usage });
      messages.push(response.message);

      if (response.stopReason === 'refusal') {
        return {
          output: undefined,
          text: textOf(response.message),
          turns: turn,
          usage,
          costUsd,
          stoppedBecause: 'refusal',
          error: 'The model declined the request.',
        };
      }

      const toolUses = toolUsesOf(response.message);
      const text = textOf(response.message);
      if (text) options.onEvent?.({ type: 'text', role: options.role, depth, text });

      if (toolUses.length === 0) {
        if (options.output && !finished && !nudged) {
          nudged = true;
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'You have not submitted a result yet. Call the finish tool now with your result.',
              },
            ],
          });
          continue;
        }
        return {
          output: finished?.value,
          text,
          turns: turn,
          usage,
          costUsd,
          stoppedBecause: options.output && !finished ? 'error' : 'finished',
          error:
            options.output && !finished ? 'The agent ended without calling finish.' : undefined,
        };
      }

      const results: ToolResultPart[] = [];
      for (const use of toolUses) {
        results.push(await this.executeTool(tools, use, toolContext, options));
      }
      messages.push({ role: 'user', content: results });

      if (finished) {
        return {
          output: finished.value,
          text,
          turns: turn,
          usage,
          costUsd,
          stoppedBecause: 'finished',
        };
      }
    }

    log.warn(`Stopped after ${resolved.maxTurns} turns without finishing`);
    return {
      output: finished?.value,
      text: '',
      turns: resolved.maxTurns,
      usage,
      costUsd,
      stoppedBecause: 'max-turns',
    };
  }

  private async executeTool<T>(
    tools: AgentTool[],
    use: ToolUsePart,
    context: ToolContext,
    options: AgentRunOptions<T>,
  ): Promise<ToolResultPart> {
    const tool = tools.find((candidate) => candidate.name === use.name);
    const depth = context.depth;
    let output: ToolOutput;
    if (!tool) {
      output = {
        content: `Unknown tool "${use.name}". Available: ${tools.map((t) => t.name).join(', ')}`,
        isError: true,
      };
    } else {
      const parsed = tool.schema.safeParse(use.input);
      if (!parsed.success) {
        output = {
          content: `Invalid input for ${tool.name}:\n${z.prettifyError(parsed.error)}`,
          isError: true,
        };
      } else {
        try {
          output = await tool.execute(parsed.data, context);
        } catch (error) {
          output = { content: `${tool.name} failed: ${errorMessage(error)}`, isError: true };
        }
      }
    }
    const content = normalizeToolOutput(output);
    const summary = truncate(
      content
        .filter((part): part is TextPart => part.type === 'text')
        .map((part) => part.text)
        .join(' '),
      160,
    );
    context.logger.debug(`${use.name} → ${output.isError ? 'error' : 'ok'}: ${summary}`);
    options.onEvent?.({
      type: 'tool',
      role: options.role,
      depth,
      name: use.name,
      ok: !output.isError,
      summary,
    });
    return { type: 'tool_result', toolUseId: use.id, content, isError: output.isError };
  }

  private pickProvider(id: string | undefined): ModelProvider {
    const { providers } = this.options;
    if (id) {
      const provider = providers.get(id);
      if (!provider) {
        throw new MutationWorkflowError(
          'PROVIDER_NOT_CONFIGURED',
          `Provider "${id}" is not configured. Known providers: ${[...providers.keys()].join(', ') || 'none'}`,
        );
      }
      return provider;
    }
    const preferred =
      [...providers.values()].find((p) => p.type === 'anthropic') ?? [...providers.values()][0];
    if (!preferred) {
      throw new MutationWorkflowError(
        'PROVIDER_NOT_CONFIGURED',
        'No model provider is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or add a providers entry to the config.',
      );
    }
    return preferred;
  }

  private checkBudget(jobId: string | undefined): string | undefined {
    if (!jobId) return undefined;
    const { maxTokensPerJob, maxUsdPerJob } = this.options.config.budget;
    const spend = this.jobSpend(jobId);
    const tokens = spend.usage.inputTokens + spend.usage.outputTokens;
    if (maxTokensPerJob !== undefined && tokens >= maxTokensPerJob) {
      return `Token budget for this job exhausted (${tokens} of ${maxTokensPerJob})`;
    }
    if (maxUsdPerJob !== undefined && spend.costUsd >= maxUsdPerJob) {
      return `Cost budget for this job exhausted ($${spend.costUsd.toFixed(2)} of $${maxUsdPerJob})`;
    }
    return undefined;
  }

  private async recordUsage(
    jobId: string | undefined,
    role: AgentRole,
    resolved: ResolvedModel,
    model: string,
    usage: TokenUsage,
    costUsd: number,
  ): Promise<void> {
    if (jobId) {
      const current = this.jobSpend(jobId);
      this.spend.set(jobId, {
        usage: addUsage(current.usage, usage),
        costUsd: current.costUsd + costUsd,
      });
    }
    if (!this.options.store) return;
    try {
      await this.options.store.usage.record({
        jobId,
        role,
        provider: resolved.provider.id,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        costUsd: costUsd || undefined,
        at: nowIso(),
      });
    } catch (error) {
      this.options.logger.warn(`Could not record model usage: ${errorMessage(error)}`);
    }
  }
}

function normalizeToolOutput(output: ToolOutput): Array<TextPart | ImagePart> {
  const parts: Array<TextPart | ImagePart> =
    typeof output.content === 'string' ? [{ type: 'text', text: output.content }] : output.content;
  const normalized = parts.map((part) =>
    part.type === 'text' ? { ...part, text: truncate(part.text, MAX_TOOL_OUTPUT_CHARS) } : part,
  );
  return normalized.length > 0 ? normalized : [{ type: 'text', text: '(no output)' }];
}

export type { ContentPart };
