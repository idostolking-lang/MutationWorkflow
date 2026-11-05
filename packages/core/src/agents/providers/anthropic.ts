import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentMessage,
  CompletionRequest,
  CompletionResponse,
  ContentPart,
  ImagePart,
  ModelProvider,
  StopReason,
  TextPart,
  TokenUsage,
  ToolSpec,
} from '../provider.js';
import { ANTHROPIC_PRICES, estimateCost, findPrice } from './pricing.js';

export interface AnthropicProviderOptions {
  id?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Anthropic Messages API. Requests stream so long tool-heavy turns never hit HTTP timeouts, and
 * the whole prompt prefix is cached automatically, which makes multi-turn agent loops cheap.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly type = 'anthropic';
  readonly supportsVision = true;
  readonly defaultModel = 'claude-opus-5-5';
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    this.id = options.id ?? 'anthropic';
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const stream = this.client.messages.stream(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map(toAnthropicMessage),
        tools: request.tools.map(toAnthropicTool),
        cache_control: { type: 'ephemeral' },
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
      },
      { signal: request.signal },
    );
    const message = await stream.finalMessage();
    return {
      message: fromAnthropicMessage(message),
      stopReason: mapStopReason(message.stop_reason),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      model: message.model,
    };
  }

  estimateCostUsd(model: string, usage: TokenUsage): number | undefined {
    const price = findPrice(model, ANTHROPIC_PRICES);
    return price ? estimateCost(price, usage) : undefined;
  }
}

function toAnthropicTool(tool: ToolSpec): Anthropic.Tool {
  const schema = tool.inputSchema;
  const inputSchema: Anthropic.Tool.InputSchema = {
    ...schema,
    type: 'object',
    properties: schema['properties'] ?? {},
  };
  return { name: tool.name, description: tool.description, input_schema: inputSchema };
}

function toAnthropicMessage(message: AgentMessage): Anthropic.MessageParam {
  if (message.role === 'assistant') {
    const content = message.content.flatMap((part): Anthropic.ContentBlockParam[] => {
      if (part.type === 'text') return part.text ? [{ type: 'text', text: part.text }] : [];
      if (part.type === 'tool_use') {
        return [{ type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} }];
      }
      return [];
    });
    return {
      role: 'assistant',
      content: content.length > 0 ? content : [{ type: 'text', text: '(empty)' }],
    };
  }
  const content: Anthropic.ContentBlockParam[] = message.content.map((part) => {
    if (part.type === 'tool_result') {
      return {
        type: 'tool_result',
        tool_use_id: part.toolUseId,
        content: part.content.map(toAnthropicBlock),
        ...(part.isError ? { is_error: true } : {}),
      };
    }
    if (part.type === 'tool_use') {
      return { type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} };
    }
    return toAnthropicBlock(part);
  });
  return { role: 'user', content };
}

function toAnthropicBlock(
  part: TextPart | ImagePart,
): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
  if (part.type === 'image') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: part.mediaType, data: part.data },
    };
  }
  return { type: 'text', text: part.text || '(empty)' };
}

function fromAnthropicMessage(message: Anthropic.Message): AgentMessage {
  const content: ContentPart[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    }
  }
  return { role: 'assistant', content };
}

function mapStopReason(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}
