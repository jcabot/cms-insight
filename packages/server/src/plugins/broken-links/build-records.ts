import { extractAnchors, type ExtractedLink } from './extract.js';
import { normalizeUrl, resolveCheckHref } from './url.js';
import type { LinkRecord } from './sidecar.js';

export interface BuildOptions {
  body: string;
  bodyHash: string;
  postId: number;
  siteUrl: string;
  stripParams: ReadonlyArray<string>;
  /** Optional previous links keyed by href, used to preserve check results across re-extractions. */
  previousByHref?: Map<string, LinkRecord>;
}

function toRecord(
  anchor: ExtractedLink,
  postId: number,
  bodyHash: string,
  stripParams: ReadonlyArray<string>,
  previousByHref: Map<string, LinkRecord> | undefined,
): LinkRecord {
  const old = previousByHref?.get(anchor.href);
  return {
    id: `${postId}:${anchor.tag_start}`,
    href: anchor.href,
    href_normalized: normalizeUrl(anchor.href, { stripParams }),
    anchor_text: anchor.anchor_text,
    tag_start: anchor.tag_start,
    tag_end: anchor.tag_end,
    inner_start: anchor.inner_start,
    inner_end: anchor.inner_end,
    href_value_start: anchor.href_value_start,
    href_value_end: anchor.href_value_end,
    href_quote: anchor.href_quote,
    body_hash_at_extraction: bodyHash,
    not_editable: anchor.not_editable,
    last_check: old?.last_check,
    action: old?.action ?? null,
    suggestion: old?.suggestion,
  };
}

export function buildLinkRecords(opts: BuildOptions): LinkRecord[] {
  const anchors = extractAnchors(opts.body);
  const out: LinkRecord[] = [];
  for (const a of anchors) {
    if (!resolveCheckHref(a.href, opts.siteUrl)) continue;
    out.push(toRecord(a, opts.postId, opts.bodyHash, opts.stripParams, opts.previousByHref));
  }
  return out;
}
