import type { PostType } from '@cms-insight/plugin-api';
import { extractAnchors } from '../broken-links/extract.js';
import { isExternal, resolveCheckHref } from '../broken-links/url.js';
import type { OutgoingLink } from './sidecar.js';

export interface TargetNode {
  /** `"<type>:<slug>"`. */
  id: string;
  type: PostType;
  slug: string;
}

export interface NodeIndex {
  /** Normalized slug → node, first match wins on collision. */
  bySlug: Map<string, TargetNode>;
  /** WordPress numeric id → node, for `?p=` / `?page_id=` permalinks. */
  byId: Map<number, TargetNode>;
}

/** The minimal post shape the index needs — keeps `buildNodeIndex` test-friendly. */
export interface IndexablePost {
  id: number | undefined;
  type: PostType;
  slug: string;
}

export function nodeId(type: PostType, slug: string): string {
  return `${type}:${slug}`;
}

/** Lower-cases and trims a slug so URL segments and stored slugs compare equal
 *  regardless of percent-encoding or surrounding slashes. */
export function normalizeSlug(raw: string): string {
  let s = raw.trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* leave as-is on malformed escapes */
  }
  return s.replace(/^\/+|\/+$/g, '').toLowerCase();
}

function lastPathSegment(pathname: string): string | undefined {
  const parts = pathname.split('/').filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

export function buildNodeIndex(posts: ReadonlyArray<IndexablePost>): NodeIndex {
  const bySlug = new Map<string, TargetNode>();
  const byId = new Map<number, TargetNode>();
  for (const p of posts) {
    const node: TargetNode = { id: nodeId(p.type, p.slug), type: p.type, slug: p.slug };
    const key = normalizeSlug(p.slug);
    if (!bySlug.has(key)) bySlug.set(key, node);
    if (p.id !== undefined && !byId.has(p.id)) byId.set(p.id, node);
  }
  return { bySlug, byId };
}

/**
 * Resolve an `<a href>` to the post/page it points at (§3). Returns the target
 * node, or `undefined` when the link is external, non-http(s), fragment-only,
 * or resolves to no known published post/page. Query-id forms win over slug
 * matches; first match wins.
 */
export function resolveTarget(
  href: string,
  siteUrl: string,
  index: NodeIndex,
): TargetNode | undefined {
  const resolved = resolveCheckHref(href, siteUrl);
  if (!resolved) return undefined;
  if (isExternal(resolved, siteUrl)) return undefined;

  let u: URL;
  try {
    u = new URL(resolved);
  } catch {
    return undefined;
  }

  const idParam = u.searchParams.get('p') ?? u.searchParams.get('page_id');
  if (idParam && /^\d+$/.test(idParam)) {
    const byId = index.byId.get(Number(idParam));
    if (byId) return byId;
  }

  const seg = lastPathSegment(u.pathname);
  if (!seg) return undefined;
  return index.bySlug.get(normalizeSlug(seg));
}

/**
 * Extract a post's deduplicated outgoing internal links. Multiple anchors to
 * the same target collapse into one {@link OutgoingLink}; self-links are
 * dropped so they never affect degree or orphan math.
 */
export function extractOutgoing(
  sourceType: PostType,
  sourceSlug: string,
  body: string,
  siteUrl: string,
  index: NodeIndex,
): OutgoingLink[] {
  const sourceId = nodeId(sourceType, sourceSlug);
  const byTarget = new Map<string, OutgoingLink>();
  for (const a of extractAnchors(body)) {
    const target = resolveTarget(a.href, siteUrl, index);
    if (!target || target.id === sourceId) continue;
    let entry = byTarget.get(target.id);
    if (!entry) {
      entry = { target_type: target.type, target_slug: target.slug, anchors: [] };
      byTarget.set(target.id, entry);
    }
    const text = a.anchor_text.trim();
    if (text && !entry.anchors.includes(text)) entry.anchors.push(text);
  }
  return [...byTarget.values()];
}
