import type {
  AnalysisContext,
  AnalysisPlugin,
  ParsedPost,
  PluginStorage,
  ProgressEvent,
} from '@cms-insight/plugin-api';
import { applyAction } from './apply.js';
import { countAllImages, extractAllImages } from './extract.js';
import { mergeFindings } from './merge.js';
import {
  buildIndex,
  listAllSidecars,
  loadIndex,
  loadSidecar,
  saveIndex,
  saveSidecar,
  sidecarKey,
  SCHEMA_VERSION,
  type DetectionRule,
  type PostSidecar,
} from './sidecar.js';
import manifest from './manifest.json' with { type: 'json' };

interface RunConfig {
  plugins?: { 'missing-alt-text'?: { flagEmptyAlt?: boolean } };
  runOptions?: { fullRecheck?: boolean; reExtractAll?: boolean };
}

async function* runPlugin(ctx: AnalysisContext): AsyncIterable<ProgressEvent> {
  const cfg = ctx.config as RunConfig;
  const opts = cfg.runOptions ?? {};
  const reExtractAll = !!opts.reExtractAll;
  const flagEmptyAlt = cfg.plugins?.['missing-alt-text']?.flagEmptyAlt ?? true;

  yield { kind: 'started' };

  const allPosts: ParsedPost[] = [];
  for await (const p of ctx.posts) {
    if (ctx.signal.aborted) {
      yield { kind: 'finished', summary: 'cancelled before scan' };
      return;
    }
    allPosts.push(p);
  }

  const total = allPosts.length;
  yield {
    kind: 'progress',
    done: 0,
    total,
    message: `Scanning ${total} post(s) for <img> tags...`,
  };

  const totalImagesByPost = new Map<string, number>();

  for (let i = 0; i < allPosts.length; i++) {
    if (ctx.signal.aborted) break;
    const p = allPosts[i];
    if (!p) continue;

    const existing = await loadSidecar(ctx.storage, p.type, p.slug);
    const needsExtract = reExtractAll || !existing || existing.body_hash !== p.bodyHash;

    let sidecar: PostSidecar;
    let imageCount: number;
    if (!needsExtract && existing) {
      // Body unchanged — trust cached findings, but sweep out fixed rows since a fresh
      // scan implies the user wants to see only outstanding issues.
      const trimmed = existing.findings.filter((f) => f.status !== 'fixed');
      if (trimmed.length !== existing.findings.length) {
        sidecar = { ...existing, findings: trimmed };
        await saveSidecar(ctx.storage, sidecar);
      } else {
        sidecar = existing;
      }
      imageCount = existing.findings.length;
      const idx = await loadIndex(ctx.storage);
      const cached = idx?.posts_with_issues.find(
        (p2) => p2.type === existing.type && p2.slug === existing.slug,
      );
      if (cached?.total_images !== undefined) imageCount = cached.total_images;
    } else {
      const body = await p.body();
      const allImages = extractAllImages(body);
      imageCount = allImages.length;
      // A fresh scan drops previously-fixed rows whose img is no longer flagged — they're
      // already settled on disk and don't need to keep cluttering the list.
      const findings = mergeFindings(allImages, existing?.findings ?? [], {
        flagEmptyAlt,
        preserveFixed: false,
      });
      sidecar = {
        schema_version: SCHEMA_VERSION,
        post_id: p.id,
        type: p.type,
        slug: p.slug,
        file_path: p.filePath,
        body_hash: p.bodyHash,
        last_scanned: new Date().toISOString(),
        findings,
      };
      await saveSidecar(ctx.storage, sidecar);
    }

    totalImagesByPost.set(sidecarKey(p.type, p.slug), imageCount);

    yield {
      kind: 'progress',
      done: i + 1,
      total,
      message: `Scanned ${i + 1}/${total}: ${p.type}/${p.slug} (${sidecar.findings.length} finding(s))`,
    };
  }

  if (ctx.signal.aborted) {
    yield { kind: 'finished', summary: 'cancelled during scan' };
    return;
  }

  const allSc: PostSidecar[] = [];
  for await (const sc of listAllSidecars(ctx.storage)) {
    allSc.push(sc);
  }
  const idx = buildIndex(allSc, totalImagesByPost);
  await saveIndex(ctx.storage, idx);

  yield {
    kind: 'finished',
    summary: `Scanned ${total} post(s); ${idx.totals.findings_open} missing alt / ${idx.totals.total_images} images`,
  };
}

async function formatHeadline(storage: PluginStorage): Promise<string | undefined> {
  const idx = await loadIndex(storage);
  if (!idx) return undefined;
  return `${idx.totals.findings_open} missing / ${idx.totals.total_images} images`;
}

const plugin: AnalysisPlugin = {
  id: manifest.id,
  displayName: manifest.displayName,
  description: manifest.description,
  version: manifest.version,
  storageSchemaVersion: manifest.storageSchemaVersion,
  resultsView: 'missing-alt-text',
  run: runPlugin,
  applyAction,
  formatHeadline,
};

export default plugin;
export type { DetectionRule };
