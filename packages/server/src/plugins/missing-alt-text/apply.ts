import type { ApplyContext, ApplyResult, PostType } from '@cms-insight/plugin-api';
import { parseFile } from '../../content/frontmatter.js';
import { hashBytes } from '../../host/hash.js';
import {
  insertAttrInOpeningTag,
  spliceAttrValue,
} from '../../host/surgical-edit.js';
import { parseBody, walk } from '../_shared/parse5-utils.js';
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
  type AltFinding,
  type PostSidecar,
} from './sidecar.js';

export interface SetAltEdit {
  postType: PostType;
  slug: string;
  findingId: string;
  /** Raw alt text typed by the user. Will be HTML-attribute-escaped before insertion. */
  altText: string;
}

export type ApplyPayload = { kind: 'set-alt'; edits: SetAltEdit[] };

function isApplyPayload(v: unknown): v is ApplyPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as { kind?: string; edits?: unknown };
  if (p.kind !== 'set-alt' || !Array.isArray(p.edits)) return false;
  return p.edits.every(
    (e) =>
      e &&
      typeof e === 'object' &&
      (e.postType === 'post' || e.postType === 'page') &&
      typeof e.slug === 'string' &&
      typeof e.findingId === 'string' &&
      typeof e.altText === 'string',
  );
}

interface PostBucket {
  type: PostType;
  slug: string;
  edits: SetAltEdit[];
}

function groupByPost(edits: SetAltEdit[]): PostBucket[] {
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

  const buckets = groupByPost(payload.edits);
  const changed: string[] = [];
  const messages: string[] = [];

  // Track the post-apply image count for each touched post so we can keep total_images
  // accurate in the rebuilt index.
  const touchedTotals = new Map<string, number>();

  for (const bucket of buckets) {
    const sc = await loadSidecar(ctx.storage, bucket.type, bucket.slug);
    if (!sc) {
      messages.push(`sidecar missing for ${bucket.type}/${bucket.slug}`);
      continue;
    }
    try {
      const total = await applyForPost(ctx, sc, bucket);
      changed.push(sc.file_path);
      touchedTotals.set(sidecarKey(sc.type, sc.slug), total);
    } catch (err) {
      messages.push(`${bucket.type}/${bucket.slug}: ${(err as Error).message}`);
    }
  }

  // Rebuild index.json so the home dashboard + KPI counters reflect the apply.
  if (changed.length > 0) {
    try {
      await rebuildIndex(ctx, touchedTotals);
    } catch (err) {
      // Index rebuild is best-effort; the next plugin run will repair it anyway.
      messages.push(`index rebuild failed: ${(err as Error).message}`);
    }
  }

  return {
    ok: messages.length === 0,
    message: messages.length === 0 ? undefined : messages.join('; '),
    changedFiles: changed,
  };
}

async function rebuildIndex(
  ctx: ApplyContext,
  touchedTotals: ReadonlyMap<string, number>,
): Promise<void> {
  const previous = await loadIndex(ctx.storage);
  // Map prior posts_with_issues entries by sidecar key for cheap lookup.
  const priorTotals = new Map<string, number>();
  if (previous) {
    for (const p of previous.posts_with_issues) {
      const key = p.type === 'post' ? `posts/${p.slug}.json` : `pages/${p.slug}.json`;
      priorTotals.set(key, p.total_images);
    }
  }
  const allSc: PostSidecar[] = [];
  for await (const sc of listAllSidecars(ctx.storage)) allSc.push(sc);

  const totals = new Map<string, number>();
  for (const sc of allSc) {
    const key = sidecarKey(sc.type, sc.slug);
    const fromTouched = touchedTotals.get(key);
    if (fromTouched !== undefined) {
      totals.set(key, fromTouched);
    } else {
      totals.set(key, priorTotals.get(key) ?? sc.findings.length);
    }
  }
  const idx = buildIndex(allSc, totals);
  await saveIndex(ctx.storage, idx);
}

/** Returns the post-apply total image count so the index rebuild stays accurate. */
async function applyForPost(
  ctx: ApplyContext,
  sidecar: PostSidecar,
  bucket: PostBucket,
): Promise<number> {
  const findingById = new Map<string, AltFinding>();
  for (const f of sidecar.findings) findingById.set(f.id, f);

  const buf = await ctx.readFile(sidecar.file_path);
  const text = buf.toString('utf8');
  const parsed = parseFile(text);
  let body = parsed.body;
  const prefix = text.slice(0, parsed.bodyByteOffset);
  if (hashBytes(body) !== sidecar.body_hash) {
    throw new Error('body hash mismatch (file changed since extraction); re-scan first');
  }

  // Track which finding ended up at which (post-rewrite) tag start, so we can re-parse
  // each rewritten <img> after splicing and assert the single-alt invariant (AC5).
  interface Plan {
    edit: SetAltEdit;
    finding: AltFinding;
  }
  const plans: Plan[] = [];
  for (const edit of bucket.edits) {
    const f = findingById.get(edit.findingId);
    if (!f) throw new Error(`finding not found: ${edit.findingId}`);
    if (f.not_editable) throw new Error(`finding ${edit.findingId} is not editable`);
    if (f.tag_start < 0) throw new Error(`finding ${edit.findingId} has no tag offset`);
    plans.push({ edit, finding: f });
  }

  // Splice descending by tag_start so earlier offsets stay valid throughout the loop.
  plans.sort((a, b) => b.finding.tag_start - a.finding.tag_start);

  for (const plan of plans) {
    const f = plan.finding;
    // Choose insert vs splice based on whether the alt attr already exists in the file.
    // This handles re-edit (alt was just inserted, now replace) and clear (set to "").
    if (f.alt_value_start >= 0) {
      body = spliceAttrValue({
        text: body,
        valueStart: f.alt_value_start,
        valueEnd: f.alt_value_end,
        quote: f.alt_quote || '"',
        newValue: plan.edit.altText,
      });
    } else {
      body = insertAttrInOpeningTag({
        text: body,
        tagStart: f.tag_start,
        tagName: 'img',
        attrName: 'alt',
        attrValue: plan.edit.altText,
      });
    }
  }

  // Single-alt invariant (PRD AC5): each rewritten <img> must carry at most one alt
  // attribute. Re-parse and check every img.
  const fragment = parseBody(body);
  walk(fragment, (el) => {
    if (el.tagName !== 'img') return;
    const altCount = el.attrs.filter((a) => a.name === 'alt').length;
    if (altCount > 1) {
      throw new Error(
        `single-alt invariant violated: <img> with ${altCount} alt attributes after rewrite`,
      );
    }
  });

  const newText = prefix + body;
  const newBuf = Buffer.from(newText, 'utf8');
  await ctx.writeFile(sidecar.file_path, newBuf, sidecar.body_hash);

  // Update sidecar: stamp applied_alt on touched findings, then re-extract from the
  // rewritten body and merge so all offsets are fresh and the rows stay editable.
  const now = new Date().toISOString();
  const newBodyHash = hashBytes(body);
  for (const plan of plans) {
    const f = sidecar.findings.find((x) => x.id === plan.edit.findingId);
    if (!f) continue;
    if (plan.edit.altText === '') {
      // Clear: file now has alt="", finding goes back to needing attention.
      f.applied_alt = undefined;
      f.applied_at = undefined;
    } else {
      f.applied_alt = plan.edit.altText;
      f.applied_at = now;
    }
  }

  const newImages = extractAllImages(body);
  // Apply must keep fixed rows so the user can immediately re-edit what they just typed.
  // The next Check new / Full check will sweep them out.
  const newFindings = mergeFindings(newImages, sidecar.findings, {
    flagEmptyAlt: true,
    preserveFixed: true,
  });

  const newSidecar: PostSidecar = {
    schema_version: SCHEMA_VERSION,
    post_id: sidecar.post_id,
    type: sidecar.type,
    slug: sidecar.slug,
    file_path: sidecar.file_path,
    body_hash: newBodyHash,
    last_scanned: now,
    findings: newFindings,
  };
  await saveSidecar(ctx.storage, newSidecar);
  // Apply only replaces alt values / adds attributes — never adds or removes <img> tags.
  // Re-count from the rewritten body so the index can stay precise.
  return countAllImages(body);
}
