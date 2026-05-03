import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmProvider,
} from '@cms-insight/plugin-api';
import { LlmError, RateLimitError, TransientLlmError } from './errors.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.client = new Anthropic({ apiKey: options.apiKey });
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const maxTokens = req.maxTokens ?? 4096;
    const systemBlock = req.cacheSystemPrompt
      ? [{ type: 'text' as const, text: req.systemPrompt, cache_control: { type: 'ephemeral' as const } }]
      : req.systemPrompt;

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: req.userMessage },
    ];

    try {
      if (req.responseSchema) {
        const tool: Anthropic.Tool = {
          name: 'submit',
          description: 'Submit the structured response',
          input_schema: req.responseSchema as Anthropic.Tool.InputSchema,
        };
        const resp = await this.client.messages.create(
          {
            model: this.model,
            max_tokens: maxTokens,
            system: systemBlock,
            messages,
            tools: [tool],
            tool_choice: { type: 'tool', name: 'submit' },
          },
          { signal: req.signal },
        );
        const toolUse = resp.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (!toolUse) {
          throw new LlmError('Anthropic response did not contain a tool_use block');
        }
        return {
          text: '',
          json: toolUse.input,
          usage: extractUsage(resp.usage),
        };
      }

      const resp = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: maxTokens,
          system: systemBlock,
          messages,
        },
        { signal: req.signal },
      );
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        text,
        usage: extractUsage(resp.usage),
      };
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }
}

function extractUsage(usage: { input_tokens: number; output_tokens: number }): {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
} {
  const cached = (usage as unknown as { cache_read_input_tokens?: number }).cache_read_input_tokens;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_input_tokens: typeof cached === 'number' ? cached : 0,
  };
}

function mapAnthropicError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.APIError) {
    if (err.status === 429) {
      const retryAfter = retryAfterFromHeaders(err.headers as Record<string, string | undefined> | undefined);
      return new RateLimitError(`Anthropic rate-limited: ${err.message}`, retryAfter, err);
    }
    if (err.status && err.status >= 500) {
      return new TransientLlmError(`Anthropic ${err.status}: ${err.message}`, err);
    }
    return new LlmError(`Anthropic ${err.status ?? '?'}: ${err.message}`, err);
  }
  if ((err as Error)?.name === 'AbortError') {
    return new LlmError('aborted', err);
  }
  return new LlmError((err as Error)?.message ?? 'unknown LLM error', err);
}

function retryAfterFromHeaders(
  headers: Record<string, string | undefined> | undefined,
): number | undefined {
  if (!headers) return undefined;
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : undefined;
}
