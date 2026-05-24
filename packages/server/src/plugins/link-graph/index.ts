import type {
  AnalysisContext,
  AnalysisPlugin,
  PluginStorage,
  ProgressEvent,
} from '@cms-insight/plugin-api';
import { runPerPost } from '../_shared/per-post-sidecar.js';
import {
  listAllSidecars,
  loadIndex,
  pruneOrphanSidecars,
  saveIndex,
  SCHEMA_VERSION,
  type PostSidecar,
} from './sidecar.js';
import { buildNodeIndex, extractOutgoing, nodeId, type NodeIndex } from './resolve.js';
import { buildGraph } from './graph.js';
import manifest from './manifest.json' with { type: 'json' };

interface RunConfig {
  runOptions?: { reExtractAll?: boolean };
}

async function* runPlugin(ctx: AnalysisContext): AsyncIterable<ProgressEvent> {
  const cfg = ctx.config as RunConfig;
  const reExtractAll = !!cfg.runOptions?.reExtractAll;

  yield { kind: 'started' };

  // Resolution needs every published slug/id before any post is extracted, so the
  // index is built once in `prepare` and closed over by `extract`.
  let index: NodeIndex = { bySlug: new Map(), byId: new Map() };
  const titleById = new Map<string, string>();

  const { presentKeys, cancelled } = yield* runPerPost<PostSidecar>(ctx, {
    schemaVersion: SCHEMA_VERSION,
    reExtractAll,
    prepare: (posts) => {
      index = buildNodeIndex(posts);
      for (const p of posts) titleById.set(nodeId(p.type, p.slug), p.title);
    },
    extract: (post, body) => ({
      outgoing: extractOutgoing(post.type, post.slug, body, ctx.siteUrl, index),
    }),
    message: (p, done, total, sc) =>
      `Scanned ${done}/${total}: ${p.type}/${p.slug} (${sc.outgoing.length} internal link(s))`,
  });

  if (cancelled) {
    yield { kind: 'finished', summary: 'cancelled during scan' };
    return;
  }

  await pruneOrphanSidecars(ctx.storage, presentKeys);

  const allSc: PostSidecar[] = [];
  for await (const sc of listAllSidecars(ctx.storage)) allSc.push(sc);
  const graph = buildGraph(allSc, titleById);
  await saveIndex(ctx.storage, graph);

  const { nodes, edges, orphans_no_in } = graph.totals;
  yield {
    kind: 'finished',
    summary: `${nodes} posts · ${edges} internal links · ${orphans_no_in} orphans`,
  };
}

async function formatHeadline(storage: PluginStorage): Promise<string | undefined> {
  const idx = await loadIndex(storage);
  if (!idx) return undefined;
  return `${idx.totals.orphans_no_in} orphans / ${idx.totals.nodes} posts`;
}

const plugin: AnalysisPlugin = {
  id: manifest.id,
  displayName: manifest.displayName,
  description: manifest.description,
  version: manifest.version,
  storageSchemaVersion: manifest.storageSchemaVersion,
  resultsView: 'link-graph',
  run: runPlugin,
  formatHeadline,
};

export default plugin;
