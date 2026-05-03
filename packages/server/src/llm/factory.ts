import type { LlmProvider } from '@cms-insight/plugin-api';
import { AnthropicProvider } from './anthropic.js';

export interface LlmConfig {
  provider: 'anthropic';
  model: string;
}

export interface CreateLlmResult {
  provider: LlmProvider | undefined;
  /** Reason the provider is undefined, suitable for surfacing to the user. */
  disabledReason?: string;
}

export function createLlmProvider(config: LlmConfig): CreateLlmResult {
  if (config.provider === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      return {
        provider: undefined,
        disabledReason:
          'ANTHROPIC_API_KEY not set — add it to <contentDir>/.cmsinsight/.env or ~/.cmsinsight/.env, or export it in your shell',
      };
    }
    return { provider: new AnthropicProvider({ apiKey, model: config.model }) };
  }
  return {
    provider: undefined,
    disabledReason: `unknown LLM provider: ${(config as { provider: string }).provider}`,
  };
}
