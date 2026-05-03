import path from 'node:path';
import type { AnalysisContext, ProgressEvent } from '@cms-insight/plugin-api';
import { loadPost } from '../../../content/post.js';
import {
  listAllSidecars,
  saveSidecar,
  type LinkRecord,
  type LinkSuggestion,
  type PostSidecar,
} from '../sidecar.js';
import { extractLinkContext } from './context.js';
import type { SuggestUserPayloadLink } from './prompts.js';
import { runBatches, type BatchResult } from './batch.js';
import type { LlmConfigSection } from '../../../config/defaults.js';

interface SuggestPayload {
  force?: boolean;
}

interface Target {
  sidecar: PostSidecar;
  link: LinkRecord;
  context: { before: string; after: string };
  postTitle: string;
}

function targetKey(t: Target): string {
  return `${t.sidecar.type}/${t.sidecar.slug}::${t.link.id}`;
}

const COST_PER_M_INPUT = 1.0;       // Anthropic Haiku 4.5 input pricing (placeholder)
const COST_PER_M_OUTPUT = 5.0;      // Haiku 4.5 output (placeholder)
const COST_PER_M_CACHED_READ = 0.1; // Haiku 4.5 cached read (placeholder)

function estimateCost(inT: number, outT: number, cachedT: number): string {
  const dollars =
    (inT * COST_PER_M_INPUT + outT * COST_PER_M_OUTPUT + cachedT * COST_PER_M_CACHED_READ) /
    1_000_000;
  return dollars >= 0.01 ? `~$${dollars.toFixed(2)}` : `<$0.01`;
}

export async function* suggestReplacements(
  ctx: AnalysisContext,
  payload: unknown,
): AsyncIterable<ProgressEvent> {
  if (!ctx.llm) {
    yield { kind: 'warn', message: 'LLM provider not configured; cannot generate suggestions' };
    yield { kind: 'finished', summary: 'aborted: LLM disabled' };
    return;
  }
  const opts = (payload ?? {}) as SuggestPayload;
  const force = !!opts.force;
  const llmCfg = (ctx.config as { llm?: LlmConfigSection }).llm;
  const batchSize = llmCfg?.suggest_batch_size ?? 20;
  const concurrency = llmCfg?.suggest_concurrency ?? 3;
  const contextChars = llmCfg?.suggest_context_chars ?? 200;

  yield { kind: 'started' };

  // Phase 1: collect targets.
  const sidecars: PostSidecar[] = [];
  for await (const sc of listAllSidecars(ctx.storage)) sidecars.push(sc);
  const candidates: { sidecar: PostSidecar; link: LinkRecord }[] = [];
  for (const sc of sidecars) {
    for (const link of sc.links) {
      if (link.last_check?.verdict !== 'BROKEN') continue;
      if (link.suggestion?.confirmed === 'cleaned' && !force) continue;
      if (link.suggestion && !force) continue;
      candidates.push({ sidecar: sc, link });
    }
  }

  if (candidates.length === 0) {
    yield { kind: 'finished', summary: 'no broken links need suggestions' };
    return;
  }

  yield {
    kind: 'progress',
    done: 0,
    total: candidates.length,
    message: `Loading context for ${candidates.length} link(s)…`,
  };

  // Phase 2: extract contexts. One body read per post.
  const targets: Target[] = [];
  const bodyCache = new Map<string, { body: string; title: string }>();
  for (const c of candidates) {
    if (ctx.signal.aborted) {
      yield { kind: 'finished', summary: 'cancelled before LLM call' };
      return;
    }
    const cacheKey = `${c.sidecar.type}/${c.sidecar.slug}`;
    let cached = bodyCache.get(cacheKey);
    if (!cached) {
      try {
        const post = await loadPost(
          path.join(ctx.contentDir, c.sidecar.file_path),
          ctx.contentDir,
        );
        const body = await post.body();
        cached = { body, title: post.title };
        bodyCache.set(cacheKey, cached);
      } catch (err) {
        yield {
          kind: 'warn',
          message: `Could not read ${c.sidecar.file_path}: ${(err as Error).message}`,
        };
        continue;
      }
    }
    const { before, after } = extractLinkContext(
      cached.body,
      c.link.tag_start,
      c.link.tag_end,
      contextChars,
    );
    targets.push({
      sidecar: c.sidecar,
      link: c.link,
      context: { before, after },
      postTitle: cached.title,
    });
  }

  if (targets.length === 0) {
    yield { kind: 'finished', summary: 'no readable targets' };
    return;
  }

  // Phase 3: build payloads + batch + call LLM.
  const targetById = new Map<string, Target>();
  const payloadLinks: SuggestUserPayloadLink[] = targets.map((t) => {
    const id = targetKey(t);
    targetById.set(id, t);
    return {
      id,
      original_url: t.link.href,
      anchor_text: t.link.anchor_text,
      post_title: t.postTitle,
      context_before: t.context.before,
      context_after: t.context.after,
      reason_broken: t.link.last_check?.reason_code ?? 'unknown',
    };
  });

  const totalBatches = Math.ceil(payloadLinks.length / batchSize);
  yield {
    kind: 'progress',
    done: 0,
    total: payloadLinks.length,
    message: `Querying ${ctx.llm.name} (${ctx.llm.model}) — ${totalBatches} batch(es) of ≤${batchSize}…`,
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let suggestionsApplied = 0;
  let batchesDone = 0;

  // Per-sidecar accumulator so we save each sidecar exactly once after all its links are done.
  const dirtySidecars = new Map<string, PostSidecar>();
  const writeQueue: Promise<void>[] = [];

  const results: BatchResult[] = await runBatches({
    llm: ctx.llm,
    siteUrl: ctx.siteUrl,
    links: payloadLinks,
    batchSize,
    concurrency,
    signal: ctx.signal,
    onBatchDone: () => {
      batchesDone++;
    },
  });

  const now = new Date().toISOString();
  const source = { provider: ctx.llm.name, model: ctx.llm.model };

  for (const res of results) {
    inputTokens += res.usage.input_tokens;
    outputTokens += res.usage.output_tokens;
    cachedTokens += res.usage.cached_input_tokens;
    if (res.error) {
      yield { kind: 'warn', message: `batch ${res.index + 1} failed: ${res.error}` };
      continue;
    }
    if (!res.output) continue;
    for (const s of res.output.suggestions) {
      const target = targetById.get(s.id);
      if (!target) continue;
      const sidecarKey = `${target.sidecar.type}/${target.sidecar.slug}`;
      const sidecarSnapshot = dirtySidecars.get(sidecarKey) ?? target.sidecar;
      const link = sidecarSnapshot.links.find((l) => l.id === target.link.id);
      if (!link) continue;
      const suggestion: LinkSuggestion = {
        url: typeof s.suggestion === 'string' && s.suggestion.length > 0 ? s.suggestion : null,
        confidence: s.confidence,
        ...(s.note ? { note: s.note } : {}),
        suggested_at: now,
        source,
        confirmed: null,
      };
      link.suggestion = suggestion;
      dirtySidecars.set(sidecarKey, sidecarSnapshot);
      suggestionsApplied++;
    }
  }

  for (const sc of dirtySidecars.values()) {
    writeQueue.push(saveSidecar(ctx.storage, sc));
  }
  await Promise.all(writeQueue);

  yield {
    kind: 'progress',
    done: payloadLinks.length,
    total: payloadLinks.length,
    message: `Wrote ${suggestionsApplied} suggestions to ${dirtySidecars.size} post(s)`,
  };

  void batchesDone;
  const cost = estimateCost(inputTokens - cachedTokens, outputTokens, cachedTokens);
  yield {
    kind: 'finished',
    summary: `Suggested ${suggestionsApplied}/${payloadLinks.length} links · ${totalBatches} batch(es) · ${inputTokens} in (${cachedTokens} cached) + ${outputTokens} out tokens · ${cost}`,
  };
}
