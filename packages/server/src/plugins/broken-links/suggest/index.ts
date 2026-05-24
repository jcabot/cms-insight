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

  const now = new Date().toISOString();
  const source = { provider: ctx.llm.name, model: ctx.llm.model };

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let suggestionsApplied = 0;
  let batchesDone = 0;
  let linksDone = 0;

  // Snapshots of the sidecars we've written into, saved incrementally per batch so partial
  // results survive a cancel or a dropped SSE connection.
  const dirtySidecars = new Map<string, PostSidecar>();

  // Producer/consumer queue: runBatches resolves batches concurrently and hands each one back
  // via onBatchDone as it lands, so we can stream progress and persist as we go instead of
  // blocking on a single Promise.all (the Phase-B pattern in ../index.ts).
  const arrived: BatchResult[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const work = runBatches({
    llm: ctx.llm,
    siteUrl: ctx.siteUrl,
    links: payloadLinks,
    batchSize,
    concurrency,
    signal: ctx.signal,
    onBatchDone: (r) => {
      arrived.push(r);
      wake?.();
      wake = undefined;
    },
  }).finally(() => {
    closed = true;
    wake?.();
    wake = undefined;
  });

  while (!closed || arrived.length > 0) {
    if (arrived.length === 0) {
      await new Promise<void>((r) => {
        wake = r;
      });
      continue;
    }
    const res = arrived.shift()!;
    batchesDone++;
    linksDone += Math.min(batchSize, payloadLinks.length - res.index * batchSize);
    inputTokens += res.usage.input_tokens;
    outputTokens += res.usage.output_tokens;
    cachedTokens += res.usage.cached_input_tokens;

    if (res.error) {
      yield {
        kind: 'warn',
        message: `batch ${res.index + 1}/${totalBatches} failed: ${res.error}`,
      };
    } else if (res.output) {
      const touched = new Set<string>();
      for (const s of res.output.suggestions) {
        const target = targetById.get(s.id);
        if (!target) continue;
        const key = `${target.sidecar.type}/${target.sidecar.slug}`;
        const snapshot = dirtySidecars.get(key) ?? target.sidecar;
        const link = snapshot.links.find((l) => l.id === target.link.id);
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
        dirtySidecars.set(key, snapshot);
        touched.add(key);
        suggestionsApplied++;
      }
      // Persist this batch's posts immediately so a later cancel can't discard them.
      for (const key of touched) await saveSidecar(ctx.storage, dirtySidecars.get(key)!);
    }

    yield {
      kind: 'progress',
      done: linksDone,
      total: payloadLinks.length,
      message: `Batch ${batchesDone}/${totalBatches} · ${suggestionsApplied} suggestion(s) so far`,
    };
  }
  await work; // surface any error that escaped the queue

  if (ctx.signal.aborted) {
    yield {
      kind: 'finished',
      summary: `Cancelled — kept ${suggestionsApplied} suggestion(s) from ${batchesDone}/${totalBatches} batch(es)`,
    };
    return;
  }

  const cost = estimateCost(inputTokens - cachedTokens, outputTokens, cachedTokens);
  yield {
    kind: 'finished',
    summary: `Suggested ${suggestionsApplied}/${payloadLinks.length} links · ${totalBatches} batch(es) · ${inputTokens} in (${cachedTokens} cached) + ${outputTokens} out tokens · ${cost}`,
  };
}
