import OpenAI from 'openai';
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

export interface OpenAIProviderOptions {
  id?: string;
  apiKey?: string;
  /** Any OpenAI-compatible endpoint (OpenAI, Azure, OpenRouter, Ollama, vLLM, ...). */
  baseUrl?: string;
  supportsVision?: boolean;
}

/**
 * Chat Completions with function calling, which is the most widely implemented surface across
 * OpenAI-compatible servers. Prices vary by vendor, so no cost estimate is produced.
 */
export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  readonly type = 'openai';
  readonly supportsVision: boolean;
  readonly defaultModel = undefined;
  private readonly client: OpenAI;

  constructor(options: OpenAIProviderOptions = {}) {
    this.id = options.id ?? 'openai';
    this.supportsVision = options.supportsVision ?? true;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const completion = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: toOpenAIMessages(request.system, request.messages),
        ...(request.tools.length > 0 ? { tools: request.tools.map(toOpenAITool) } : {}),
        max_completion_tokens: request.maxTokens,
        ...(request.effort ? { reasoning_effort: mapEffort(request.effort) } : {}),
      },
      { signal: request.signal },
    );
    const choice = completion.choices[0];
    if (!choice) {
      throw new Error(`${this.id} returned no choices for model ${request.model}`);
    }
    const content: ContentPart[] = [];
    if (typeof choice.message.content === 'string' && choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }
    for (const call of choice.message.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      });
    }
    return {
      message: { role: 'assistant', content },
      stopReason: mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        cacheReadTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
      model: completion.model,
    };
  }

  estimateCostUsd(_model: string, _usage: TokenUsage): number | undefined {
    return undefined;
  }
}

function mapEffort(effort: NonNullable<CompletionRequest['effort']>): 'low' | 'medium' | 'high' {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}

function toOpenAITool(tool: ToolSpec): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function toOpenAIMessages(
  system: string,
  messages: AgentMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((part): part is TextPart => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      const toolCalls = message.content.flatMap((part) =>
        part.type === 'tool_use'
          ? [
              {
                id: part.id,
                type: 'function' as const,
                function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
              },
            ]
          : [],
      );
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // Tool results must be `tool` messages with text content; images ride along in a user message.
    const trailingImages: ImagePart[] = [];
    const userParts: Array<TextPart | ImagePart> = [];
    for (const part of message.content) {
      if (part.type === 'tool_result') {
        const text = part.content
          .filter((item): item is TextPart => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        trailingImages.push(
          ...part.content.filter((item): item is ImagePart => item.type === 'image'),
        );
        out.push({ role: 'tool', tool_call_id: part.toolUseId, content: text || '(no output)' });
      } else if (part.type === 'text' || part.type === 'image') {
        userParts.push(part);
      }
    }
    const extra = [...userParts, ...trailingImages];
    if (extra.length > 0) {
      out.push({ role: 'user', content: extra.map(toOpenAIPart) });
    }
  }
  return out;
}

function toOpenAIPart(
  part: TextPart | ImagePart,
): OpenAI.Chat.Completions.ChatCompletionContentPart {
  if (part.type === 'image') {
    return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } };
  }
  return { type: 'text', text: part.text };
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { _invalidJson: raw };
  }
}

function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}
