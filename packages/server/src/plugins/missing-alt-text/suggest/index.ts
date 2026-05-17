import path from 'node:path';
import type { AnalysisContext, ProgressEvent } from '@cms-insight/plugin-api';
import { loadPost } from '../../../content/post.js';
import { extractLinkContext } from '../../broken-links/suggest/context.js';
import type { LlmConfigSection } from '../../../config/defaults.js';
import {
  listAllSidecars,
  saveSidecar,
  type AltFinding,
  type AltSuggestion,
  type PostSidecar,
} from '../sidecar.js';
import { fetchImage, resolveImageUrl } from './fetch-image.js';
import {
  SUGGESTION_SCHEMA,
  SYSTEM_PROMPT,
  buildUserMessage,
  isSuggestionToolOutput,
} from './prompts.js';

interface SuggestPayload {
  force?: boolean;
}

const VERSION = '0.1.0';

// Anthropic Haiku 4.5 placeholder pricing — kept loose since vision tokens are billed
// the same way as text tokens once the image is encoded.
const COST_PER_M_INPUT = 1.0;
const COST_PER_M_OUTPUT = 5.0;
const COST_PER_M_CACHED_READ = 0.1;

function estimateCost(inT: number, outT: number, cachedT: number): string {
  const dollars =
    (inT * COST_PER_M_INPUT + outT * COST_PER_M_OUTPUT + cachedT * COST_PER_M_CACHED_READ) /
    1_000_000;
  return dollars >= 0.01 ? `~$${dollars.toFixed(2)}` : `<$0.01`;
}

export async function* suggestAltText(
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
  const contextChars = llmCfg?.suggest_context_chars ?? 200;
  const userAgent = `cms-insight/${VERSION} (+${ctx.siteUrl})`;

  yield { kind: 'started' };

  // Collect open findings that need a suggestion.
  const sidecars: PostSidecar[] = [];
  for await (const sc of listAllSidecars(ctx.storage)) sidecars.push(sc);

  interface Candidate {
    sidecar: PostSidecar;
    finding: AltFinding;
  }
  const candidates: Candidate[] = [];
  for (const sc of sidecars) {
    for (const f of sc.findings) {
      if (f.status !== 'open') continue;
      if (f.not_editable) continue;
      if (!f.src) continue;
      if (!force && f.alt_suggestion) continue;
      candidates.push({ sidecar: sc, finding: f });
    }
  }

  if (candidates.length === 0) {
    yield { kind: 'finished', summary: 'no open findings need suggestions' };
    return;
  }

  yield {
    kind: 'progress',
    done: 0,
    total: candidates.length,
    message: `Generating alt-text suggestions for ${candidates.length} image(s)…`,
  };

  // Cache post body + title across candidates from the same post.
  const bodyCache = new Map<string, { body: string; title: string }>();
  const dirty = new Map<string, PostSidecar>();

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let succeeded = 0;
  let skipped = 0;
  let nullResults = 0;
  let processed = 0;

  const now = (): string => new Date().toISOString();
  const source = { provider: ctx.llm.name, model: ctx.llm.model };

  for (const c of candidates) {
    if (ctx.signal.aborted) {
      yield { kind: 'finished', summary: `cancelled after ${processed}/${candidates.length}` };
      break;
    }
    processed++;
    const cacheKey = `${c.sidecar.type}/${c.sidecar.slug}`;
    let cached = bodyCache.get(cacheKey);
    if (!cached) {
      try {
        const post = await loadPost(
          path.join(ctx.contentDir, c.sidecar.file_path),
          ctx.contentDir,
        );
        cached = { body: await post.body(), title: post.title };
        bodyCache.set(cacheKey, cached);
      } catch (err) {
        skipped++;
        yield {
          kind: 'warn',
          message: `${c.sidecar.file_path}: cannot read post body (${(err as Error).message})`,
        };
        yield {
          kind: 'progress',
          done: processed,
          total: candidates.length,
          message: `Skipped ${c.sidecar.type}/${c.sidecar.slug}`,
        };
        continue;
      }
    }

    const resolvedUrl = resolveImageUrl(c.finding.src, ctx.siteUrl);
    if (!resolvedUrl) {
      skipped++;
      yield {
        kind: 'progress',
        done: processed,
        total: candidates.length,
        message: `Skipped (un-fetchable src): ${c.finding.src}`,
      };
      continue;
    }

    const fetched = await fetchImage(resolvedUrl, ctx.signal, userAgent);
    if (!fetched.ok) {
      skipped++;
      yield {
        kind: 'warn',
        message: `${c.finding.src}: ${fetched.reason}`,
      };
      yield {
        kind: 'progress',
        done: processed,
        total: candidates.length,
        message: `Skipped image (${fetched.reason})`,
      };
      continue;
    }

    const { before, after } = extractLinkContext(
      cached.body,
      c.finding.tag_start,
      c.finding.tag_end,
      contextChars,
    );
    const userMessage = buildUserMessage({
      postTitle: cached.title,
      contextBefore: before,
      contextAfter: after,
      imageSrc: c.finding.src,
    });

    try {
      const resp = await ctx.llm.complete({
        systemPrompt: SYSTEM_PROMPT,
        userMessage,
        images: [fetched.image],
        responseSchema: SUGGESTION_SCHEMA as object,
        cacheSystemPrompt: true,
        maxTokens: 256,
        signal: ctx.signal,
      });
      inputTokens += resp.usage.input_tokens;
      outputTokens += resp.usage.output_tokens;
      cachedTokens += resp.usage.cached_input_tokens ?? 0;

      if (!isSuggestionToolOutput(resp.json)) {
        skipped++;
        yield {
          kind: 'warn',
          message: `${c.finding.src}: LLM returned malformed output`,
        };
        continue;
      }

      const suggestion: AltSuggestion = {
        text: resp.json.text,
        confidence: resp.json.confidence,
        ...(resp.json.note ? { note: resp.json.note } : {}),
        suggested_at: now(),
        source,
        confirmed: null,
      };
      const scKey = `${c.sidecar.type}/${c.sidecar.slug}`;
      const scSnap = dirty.get(scKey) ?? c.sidecar;
      const fSnap = scSnap.findings.find((x) => x.id === c.finding.id);
      if (fSnap) fSnap.alt_suggestion = suggestion;
      dirty.set(scKey, scSnap);

      if (resp.json.text === null) nullResults++;
      else succeeded++;
    } catch (err) {
      skipped++;
      yield {
        kind: 'warn',
        message: `${c.finding.src}: LLM call failed (${(err as Error).message})`,
      };
    }

    yield {
      kind: 'progress',
      done: processed,
      total: candidates.length,
      message: `Suggested ${succeeded}/${processed} (skipped ${skipped}, unsure ${nullResults})`,
    };
  }

  // Persist dirty sidecars once each.
  await Promise.all(Array.from(dirty.values()).map((sc) => saveSidecar(ctx.storage, sc)));

  const cost = estimateCost(inputTokens - cachedTokens, outputTokens, cachedTokens);
  yield {
    kind: 'finished',
    summary:
      `Suggested ${succeeded}/${candidates.length} image(s)` +
      (nullResults > 0 ? ` · unsure ${nullResults}` : '') +
      (skipped > 0 ? ` · skipped ${skipped}` : '') +
      ` · ${inputTokens} in (${cachedTokens} cached) + ${outputTokens} out tokens · ${cost}`,
  };
}
