import type { ApplyContext, ApplyResult, PostType } from '@cms-insight/plugin-api';
import { parseFile } from '../../content/frontmatter.js';
import { hashBytes } from '../../host/hash.js';
import {
  spliceHrefValue,
  removeAnchorPreserveText,
} from '../../host/surgical-edit.js';
import { buildLinkRecords } from './build-records.js';
import {
  loadSidecar,
  saveSidecar,
  type ActionType,
  type LinkAction,
  type LinkRecord,
  type PostSidecar,
  SCHEMA_VERSION,
} from './sidecar.js';

export interface ApplyEdit {
  postType: PostType;
  slug: string;
  linkId: string;
  action: ActionType;
  newHref?: string;
}

export type ApplyPayload =
  | { kind: 'edit'; edits: ApplyEdit[]; siteUrl: string; stripParams: ReadonlyArray<string> }
  | { kind: 'clean-suggestion'; postType: PostType; slug: string; linkId: string }
  | { kind: 'reset-suggestion'; postType: PostType; slug: string; linkId: string };

function isApplyPayload(v: unknown): v is ApplyPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as { kind?: string };
  if (p.kind === 'edit') {
    const ep = v as Partial<Extract<ApplyPayload, { kind: 'edit' }>>;
    return (
      Array.isArray(ep.edits) && typeof ep.siteUrl === 'string' && Array.isArray(ep.stripParams)
    );
  }
  if (p.kind === 'clean-suggestion' || p.kind === 'reset-suggestion') {
    const sp = v as Partial<Extract<ApplyPayload, { kind: 'clean-suggestion' }>>;
    return (
      (sp.postType === 'post' || sp.postType === 'page') &&
      typeof sp.slug === 'string' &&
      typeof sp.linkId === 'string'
    );
  }
  return false;
}

interface PostBucket {
  type: PostType;
  slug: string;
  edits: ApplyEdit[];
}

function groupByPost(edits: ApplyEdit[]): PostBucket[] {
  const buckets = new Map<string, PostBucket>();
  for (const e of edits) {
    const key = `${e.postType}/${e.slug}`;
    let b = buckets.get(key);
    if (!b) {
      b = { type: e.postType, slug: e.slug, edits: [] };
      buckets.set(key, b);
    }
    b.edits.push(e);
  }
  return [...buckets.values()];
}

export async function applyAction(
  ctx: ApplyContext,
  payload: unknown,
): Promise<ApplyResult> {
  if (!isApplyPayload(payload)) {
    return { ok: false, message: 'invalid payload' };
  }
  if (payload.kind === 'clean-suggestion' || payload.kind === 'reset-suggestion') {
    return mutateSuggestionState(
      ctx,
      payload.postType,
      payload.slug,
      payload.linkId,
      payload.kind === 'clean-suggestion' ? 'cleaned' : 'reset',
    );
  }

  const p = payload;
  const buckets = groupByPost(p.edits);
  const changed: string[] = [];
  const messages: string[] = [];

  for (const bucket of buckets) {
    const sc = await loadSidecar(ctx.storage, bucket.type, bucket.slug);
    if (!sc) {
      messages.push(`sidecar missing for ${bucket.type}/${bucket.slug}`);
      continue;
    }
    try {
      await applyForPost(ctx, sc, bucket, p);
      if (bucket.edits.some((e) => e.action !== 'keep')) {
        changed.push(sc.file_path);
      }
    } catch (err) {
      messages.push(
        `${bucket.type}/${bucket.slug}: ${(err as Error).message}`,
      );
    }
  }

  return {
    ok: messages.length === 0,
    message: messages.length === 0 ? undefined : messages.join('; '),
    changedFiles: changed,
  };
}

async function mutateSuggestionState(
  ctx: ApplyContext,
  postType: PostType,
  slug: string,
  linkId: string,
  mode: 'cleaned' | 'reset',
): Promise<ApplyResult> {
  const sc = await loadSidecar(ctx.storage, postType, slug);
  if (!sc) return { ok: false, message: `sidecar missing for ${postType}/${slug}` };
  const link = sc.links.find((l) => l.id === linkId);
  if (!link) return { ok: false, message: `link ${linkId} not found in ${postType}/${slug}` };
  if (!link.suggestion) return { ok: false, message: `no suggestion to update on ${linkId}` };
  if (mode === 'cleaned') {
    link.suggestion.confirmed = 'cleaned';
  } else {
    link.suggestion.confirmed = null;
  }
  await saveSidecar(ctx.storage, sc);
  return { ok: true, changedFiles: [] };
}

async function applyForPost(
  ctx: ApplyContext,
  sidecar: PostSidecar,
  bucket: PostBucket,
  payload: Extract<ApplyPayload, { kind: 'edit' }>,
): Promise<void> {
  // Find link records
  const linkById = new Map<string, LinkRecord>();
  for (const l of sidecar.links) linkById.set(l.id, l);

  // Read file
  const buf = await ctx.readFile(sidecar.file_path);
  const text = buf.toString('utf8');
  const parsed = parseFile(text);
  let body = parsed.body;
  const prefix = text.slice(0, parsed.bodyByteOffset);
  const oldBodyHash = hashBytes(body);
  if (oldBodyHash !== sidecar.body_hash) {
    throw new Error('body hash mismatch (file changed since extraction); re-scan first');
  }

  // Separate keep from body-modifying edits
  const bodyEdits = bucket.edits.filter((e) => e.action !== 'keep');
  // Sort by tag_start descending so earlier offsets remain valid
  bodyEdits.sort((a, b) => {
    const la = linkById.get(a.linkId);
    const lb = linkById.get(b.linkId);
    return (lb?.tag_start ?? 0) - (la?.tag_start ?? 0);
  });

  for (const edit of bodyEdits) {
    const link = linkById.get(edit.linkId);
    if (!link) throw new Error(`link not found: ${edit.linkId}`);
    if (link.not_editable) {
      throw new Error(`link ${edit.linkId} is marked not_editable; edit manually`);
    }
    if (edit.action === 'replace') {
      if (typeof edit.newHref !== 'string' || edit.newHref.length === 0) {
        throw new Error(`replace requires newHref for ${edit.linkId}`);
      }
      body = spliceHrefValue({
        text: body,
        hrefValueStart: link.href_value_start,
        hrefValueEnd: link.href_value_end,
        hrefQuote: link.href_quote,
        newHref: edit.newHref,
      });
    } else if (edit.action === 'remove') {
      body = removeAnchorPreserveText({
        text: body,
        tagStart: link.tag_start,
        innerStart: link.inner_start,
        innerEnd: link.inner_end,
        tagEnd: link.tag_end,
      });
    }
  }

  if (bodyEdits.length > 0) {
    const newText = prefix + body;
    const newBuf = Buffer.from(newText, 'utf8');
    await ctx.writeFile(sidecar.file_path, newBuf, sidecar.body_hash);
  }

  const newBodyHash = hashBytes(body);
  const previousByHref = new Map<string, LinkRecord>();
  for (const old of sidecar.links) {
    if (!previousByHref.has(old.href)) previousByHref.set(old.href, old);
  }
  const newLinks = buildLinkRecords({
    body,
    bodyHash: newBodyHash,
    postId: sidecar.post_id ?? 0,
    siteUrl: payload.siteUrl,
    stripParams: payload.stripParams,
    previousByHref,
  });
  for (const l of newLinks) l.action = null;

  // Mark applied actions
  const now = new Date().toISOString();
  for (const edit of bucket.edits) {
    if (edit.action === 'keep') {
      const orig = linkById.get(edit.linkId);
      if (!orig) continue;
      const match = newLinks.find((l) => l.href === orig.href);
      const action: LinkAction = { type: 'keep', new_href: null, applied_at: now };
      if (match) match.action = action;
    } else if (edit.action === 'replace' && edit.newHref) {
      const match = newLinks.find((l) => l.href === edit.newHref);
      const action: LinkAction = {
        type: 'replace',
        new_href: edit.newHref,
        applied_at: now,
      };
      if (match) match.action = action;
    }
  }

  const newSidecar: PostSidecar = {
    schema_version: SCHEMA_VERSION,
    post_id: sidecar.post_id,
    type: sidecar.type,
    slug: sidecar.slug,
    file_path: sidecar.file_path,
    body_hash: newBodyHash,
    last_scanned: now,
    links: newLinks,
  };

  await saveSidecar(ctx.storage, newSidecar);
}
