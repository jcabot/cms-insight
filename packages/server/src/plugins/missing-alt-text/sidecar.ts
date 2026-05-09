import type { PluginStorage, PostType } from '@cms-insight/plugin-api';
import type { AttrQuote } from '../../host/surgical-edit.js';

export const SCHEMA_VERSION = 1;

export type DetectionRule = 'D1' | 'D2' | 'D3';
export type FindingStatus = 'open' | 'fixed';

export interface AltFinding {
  id: string;
  /** The img's `src` attribute (raw). */
  src: string;
  /** Current detection rule. Undefined when the img is not currently flagged but
   *  was previously fixed by the user (preserved as a re-editable row). */
  rule?: DetectionRule;
  status: FindingStatus;
  /** Byte offsets in the post body at extraction time. Stale on body change (gated by body_hash). */
  tag_start: number;
  tag_end: number;
  /** Offsets of the existing `alt` attribute value, when present. -1/-1 only when alt is absent (D1 untouched). */
  alt_value_start: number;
  alt_value_end: number;
  alt_quote: AttrQuote;
  /** Short snippet for UI context (text immediately before/after the tag). */
  context_before: string;
  context_after: string;
  /** True when offsets couldn't be derived; UI hides Apply for these. */
  not_editable?: boolean;
  /** The most recently applied alt text. Pre-fills the edit form so users can re-edit. */
  applied_alt?: string;
  /** ISO timestamp of the last successful apply. */
  applied_at?: string;
}

export interface PostSidecar {
  schema_version: number;
  post_id: number | undefined;
  type: PostType;
  slug: string;
  file_path: string;
  body_hash: string;
  last_scanned: string;
  findings: AltFinding[];
}

export interface PostIssueSummary {
  type: PostType;
  slug: string;
  total_images: number;
  findings_open: number;
}

export interface IndexFile {
  schema_version: number;
  last_run_completed: string;
  posts_scanned: number;
  totals: {
    total_images: number;
    findings_open: number;
    findings_fixed: number;
  };
  posts_with_issues: PostIssueSummary[];
}

export function sidecarKey(type: PostType, slug: string): string {
  return type === 'post' ? `posts/${slug}.json` : `pages/${slug}.json`;
}

export async function loadSidecar(
  storage: PluginStorage,
  type: PostType,
  slug: string,
): Promise<PostSidecar | undefined> {
  const data = await storage.read<PostSidecar>(sidecarKey(type, slug));
  if (!data) return undefined;
  if (data.schema_version !== SCHEMA_VERSION) return undefined;
  return data;
}

export async function saveSidecar(storage: PluginStorage, sidecar: PostSidecar): Promise<void> {
  await storage.write(sidecarKey(sidecar.type, sidecar.slug), sidecar);
}

export async function loadIndex(storage: PluginStorage): Promise<IndexFile | undefined> {
  const idx = await storage.read<IndexFile>('index.json');
  if (!idx || idx.schema_version !== SCHEMA_VERSION) return undefined;
  return idx;
}

export async function saveIndex(storage: PluginStorage, index: IndexFile): Promise<void> {
  await storage.write('index.json', index);
}

export async function* listAllSidecars(
  storage: PluginStorage,
): AsyncIterable<PostSidecar> {
  for await (const key of storage.list()) {
    if (key === 'index.json') continue;
    if (!key.endsWith('.json')) continue;
    if (!key.startsWith('posts/') && !key.startsWith('pages/')) continue;
    const sc = await storage.read<PostSidecar>(key);
    if (sc && sc.schema_version === SCHEMA_VERSION) yield sc;
  }
}

export function buildIndex(
  sidecars: ReadonlyArray<PostSidecar>,
  totalImagesByPost: ReadonlyMap<string, number>,
): IndexFile {
  let totalImages = 0;
  let findingsOpen = 0;
  let findingsFixed = 0;
  const issues: PostIssueSummary[] = [];
  for (const sc of sidecars) {
    const key = sidecarKey(sc.type, sc.slug);
    const total = totalImagesByPost.get(key) ?? sc.findings.length;
    totalImages += total;
    let open = 0;
    let fixed = 0;
    for (const f of sc.findings) {
      if (f.status === 'open') open++;
      else if (f.status === 'fixed') fixed++;
    }
    findingsOpen += open;
    findingsFixed += fixed;
    if (open > 0) {
      issues.push({ type: sc.type, slug: sc.slug, total_images: total, findings_open: open });
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    last_run_completed: new Date().toISOString(),
    posts_scanned: sidecars.length,
    totals: {
      total_images: totalImages,
      findings_open: findingsOpen,
      findings_fixed: findingsFixed,
    },
    posts_with_issues: issues,
  };
}
