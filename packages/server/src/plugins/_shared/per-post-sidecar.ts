import type {
  AnalysisContext,
  ParsedPost,
  PluginStorage,
  PostType,
  ProgressEvent,
} from '@cms-insight/plugin-api';

/**
 * Fields every per-post sidecar shares. Concrete plugins extend this with their
 * own finding payload (`links`, `findings`, `outgoing`, …) and an `IndexFile`.
 */
export interface BasePostSidecar {
  schema_version: number;
  post_id: number | undefined;
  type: PostType;
  slug: string;
  file_path: string;
  body_hash: string;
  last_scanned: string;
}

export function sidecarKey(type: PostType, slug: string): string {
  return type === 'post' ? `posts/${slug}.json` : `pages/${slug}.json`;
}

export async function loadSidecar<T extends BasePostSidecar>(
  storage: PluginStorage,
  type: PostType,
  slug: string,
  schemaVersion: number,
): Promise<T | undefined> {
  const data = await storage.read<T>(sidecarKey(type, slug));
  if (!data) return undefined;
  if (data.schema_version !== schemaVersion) return undefined;
  return data;
}

export async function saveSidecar<T extends BasePostSidecar>(
  storage: PluginStorage,
  sidecar: T,
): Promise<void> {
  await storage.write(sidecarKey(sidecar.type, sidecar.slug), sidecar);
}

export async function loadIndex<T extends { schema_version: number }>(
  storage: PluginStorage,
  schemaVersion: number,
): Promise<T | undefined> {
  const idx = await storage.read<T>('index.json');
  if (!idx || idx.schema_version !== schemaVersion) return undefined;
  return idx;
}

export async function saveIndex(storage: PluginStorage, index: unknown): Promise<void> {
  await storage.write('index.json', index);
}

export async function* listAllSidecars<T extends BasePostSidecar>(
  storage: PluginStorage,
  schemaVersion: number,
): AsyncIterable<T> {
  for await (const key of storage.list()) {
    if (key === 'index.json') continue;
    if (!key.endsWith('.json')) continue;
    if (!key.startsWith('posts/') && !key.startsWith('pages/')) continue;
    const sc = await storage.read<T>(key);
    if (sc && sc.schema_version === schemaVersion) yield sc;
  }
}

/** Delete sidecar files whose post is no longer present in the content set. */
export async function pruneOrphanSidecars(
  storage: PluginStorage,
  presentKeys: ReadonlySet<string>,
): Promise<void> {
  for await (const key of storage.list()) {
    if (key === 'index.json' || !key.endsWith('.json')) continue;
    if (!key.startsWith('posts/') && !key.startsWith('pages/')) continue;
    if (!presentKeys.has(key)) await storage.delete(key);
  }
}

export interface RunPerPostResult<T extends BasePostSidecar> {
  /** Sidecars for every present post, whether freshly extracted or cached. */
  sidecars: T[];
  /** Sidecar keys of every present post — pass to {@link pruneOrphanSidecars}. */
  presentKeys: Set<string>;
  /** True when the run was aborted mid-scan via `ctx.signal`. */
  cancelled: boolean;
}

export interface RunPerPostOptions<T extends BasePostSidecar> {
  schemaVersion: number;
  /** Force re-extraction even when `body_hash` is unchanged. */
  reExtractAll: boolean;
  /**
   * Runs once after all posts are drained and before per-post extraction, so a
   * plugin can build a cross-post index (e.g. slug→node) the extractor needs.
   */
  prepare?: (posts: ReadonlyArray<ParsedPost>) => void | Promise<void>;
  /**
   * Builds the finding payload for a post whose body changed (or under
   * `reExtractAll`). Returns only the plugin-specific fields; the shared header
   * (`schema_version`, ids, hash, timestamp) is filled in by the runner.
   */
  extract: (
    post: ParsedPost,
    body: string,
    previous: T | undefined,
  ) => Promise<Omit<T, keyof BasePostSidecar>> | Omit<T, keyof BasePostSidecar>;
  /** Optional per-post progress message; defaults to `"<type>/<slug>"`. */
  message?: (post: ParsedPost, done: number, total: number, sidecar: T) => string;
}

/**
 * Drives the single-phase per-post extraction loop shared by simple plugins:
 * drain `ctx.posts`, apply the body-hash incremental gate, build sidecars, and
 * yield `started`/`progress` events. Aggregation (index build, prune) is left to
 * the caller, which captures the generator's return value:
 *
 * ```ts
 * const { sidecars, presentKeys, cancelled } = yield* runPerPost(ctx, { … });
 * ```
 */
export async function* runPerPost<T extends BasePostSidecar>(
  ctx: AnalysisContext,
  opts: RunPerPostOptions<T>,
): AsyncGenerator<ProgressEvent, RunPerPostResult<T>> {
  const posts: ParsedPost[] = [];
  for await (const p of ctx.posts) {
    if (ctx.signal.aborted) {
      return { sidecars: [], presentKeys: new Set(), cancelled: true };
    }
    posts.push(p);
  }

  await opts.prepare?.(posts);

  const total = posts.length;
  yield { kind: 'progress', done: 0, total, message: `Scanning ${total} post(s)...` };

  const sidecars: T[] = [];
  const presentKeys = new Set<string>();

  for (let i = 0; i < posts.length; i++) {
    if (ctx.signal.aborted) {
      return { sidecars, presentKeys, cancelled: true };
    }
    const p = posts[i];
    if (!p) continue;
    presentKeys.add(sidecarKey(p.type, p.slug));

    const prev = await loadSidecar<T>(ctx.storage, p.type, p.slug, opts.schemaVersion);
    const needsExtract = opts.reExtractAll || !prev || prev.body_hash !== p.bodyHash;

    let sc: T;
    if (needsExtract) {
      const body = await p.body();
      const payload = await opts.extract(p, body, prev);
      sc = {
        schema_version: opts.schemaVersion,
        post_id: p.id,
        type: p.type,
        slug: p.slug,
        file_path: p.filePath,
        body_hash: p.bodyHash,
        last_scanned: new Date().toISOString(),
        ...payload,
      } as T;
      await saveSidecar(ctx.storage, sc);
    } else {
      sc = prev;
    }
    sidecars.push(sc);

    yield {
      kind: 'progress',
      done: i + 1,
      total,
      message: opts.message?.(p, i + 1, total, sc) ?? `Scanned ${i + 1}/${total}: ${p.type}/${p.slug}`,
    };
  }

  return { sidecars, presentKeys, cancelled: false };
}
