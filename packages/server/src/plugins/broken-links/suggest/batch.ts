import PQueue from 'p-queue';
import type { LlmProvider } from '@cms-insight/plugin-api';
import {
  SUGGEST_SYSTEM_PROMPT,
  SUGGEST_TOOL_SCHEMA,
  buildUserMessage,
  type SuggestUserPayloadLink,
  type SuggestToolOutput,
} from './prompts.js';
import { isRetryable, RateLimitError } from '../../../llm/errors.js';

export interface BatchResult {
  index: number;
  output?: SuggestToolOutput;
  error?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
  };
}

export interface RunBatchesOptions {
  llm: LlmProvider;
  siteUrl: string;
  links: SuggestUserPayloadLink[];
  batchSize: number;
  concurrency: number;
  signal: AbortSignal;
  maxRetries?: number;
  onBatchDone?: (result: BatchResult) => void;
}

function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  if (size < 1) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => resolve(), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });

async function callOnce(
  llm: LlmProvider,
  siteUrl: string,
  batch: SuggestUserPayloadLink[],
  signal: AbortSignal,
): Promise<{ output: SuggestToolOutput; usage: BatchResult['usage'] }> {
  const userMessage = buildUserMessage({ site_url: siteUrl, links: batch });
  const resp = await llm.complete({
    systemPrompt: SUGGEST_SYSTEM_PROMPT,
    userMessage,
    cacheSystemPrompt: true,
    responseSchema: SUGGEST_TOOL_SCHEMA,
    maxTokens: 4096,
    signal,
  });
  const output = resp.json as SuggestToolOutput | undefined;
  if (!output || !Array.isArray(output.suggestions)) {
    throw new Error('LLM response did not contain a suggestions array');
  }
  return {
    output,
    usage: {
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
      cached_input_tokens: resp.usage.cached_input_tokens ?? 0,
    },
  };
}

async function callWithRetries(
  llm: LlmProvider,
  siteUrl: string,
  batch: SuggestUserPayloadLink[],
  signal: AbortSignal,
  maxRetries: number,
): Promise<{ output: SuggestToolOutput; usage: BatchResult['usage'] }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callOnce(llm, siteUrl, batch, signal);
    } catch (err) {
      lastErr = err;
      if (signal.aborted) throw err;
      if (!isRetryable(err) || attempt === maxRetries) throw err;
      const wait =
        err instanceof RateLimitError && err.retryAfterMs ? err.retryAfterMs : 1000 * 2 ** attempt;
      await sleep(wait, signal);
    }
  }
  throw lastErr ?? new Error('LLM call failed');
}

export async function runBatches(opts: RunBatchesOptions): Promise<BatchResult[]> {
  const batches = chunk(opts.links, opts.batchSize);
  const maxRetries = opts.maxRetries ?? 2;
  const queue = new PQueue({ concurrency: opts.concurrency });
  const results: BatchResult[] = [];
  await Promise.all(
    batches.map((batch, index) =>
      queue.add(async () => {
        if (opts.signal.aborted) return;
        const usageZero = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
        try {
          const { output, usage } = await callWithRetries(
            opts.llm,
            opts.siteUrl,
            batch,
            opts.signal,
            maxRetries,
          );
          const r: BatchResult = { index, output, usage };
          results.push(r);
          opts.onBatchDone?.(r);
        } catch (err) {
          const r: BatchResult = {
            index,
            error: (err as Error).message,
            usage: usageZero,
          };
          results.push(r);
          opts.onBatchDone?.(r);
        }
      }),
    ),
  );
  results.sort((a, b) => a.index - b.index);
  return results;
}
