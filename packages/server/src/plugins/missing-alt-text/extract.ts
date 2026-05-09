import type { AttrQuote } from '../../host/surgical-edit.js';
import { findAttrValueSpan, getAttr, parseBody, walk } from '../_shared/parse5-utils.js';
import type { DetectionRule } from './sidecar.js';

const CONTEXT_CHARS = 20;

export interface ExtractedImage {
  src: string;
  /** Undefined when the img has a usable alt (no rule matches). */
  rule?: DetectionRule;
  tag_start: number;
  tag_end: number;
  alt_value_start: number;
  alt_value_end: number;
  alt_quote: AttrQuote;
  context_before: string;
  context_after: string;
  not_editable?: boolean;
}

function classify(altRaw: string | undefined): DetectionRule | undefined {
  if (altRaw === undefined) return 'D1';
  if (altRaw === '') return 'D3';
  if (altRaw.trim() === '') return 'D2';
  return undefined;
}

function snippet(body: string, start: number, end: number): string {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(body.length, end);
  return body.slice(safeStart, safeEnd).replace(/\s+/g, ' ').trim();
}

/** Walk every <img> tag in document order, returning offsets + classification (undefined when good). */
export function extractAllImages(body: string): ExtractedImage[] {
  const fragment = parseBody(body);
  const out: ExtractedImage[] = [];

  walk(fragment, (el) => {
    if (el.tagName !== 'img') return;
    const src = getAttr(el, 'src') ?? '';
    const altRaw = getAttr(el, 'alt');
    const rule = classify(altRaw);

    const loc = el.sourceCodeLocation;
    if (!loc || !loc.startTag) {
      out.push({
        src,
        rule,
        tag_start: -1,
        tag_end: -1,
        alt_value_start: -1,
        alt_value_end: -1,
        alt_quote: '',
        context_before: '',
        context_after: '',
        not_editable: true,
      });
      return;
    }

    const tagStart = loc.startTag.startOffset;
    const tagEnd = loc.endTag?.endOffset ?? loc.startTag.endOffset;

    // Resolve alt-value span when the attribute is present (any rule except D1, OR a good alt).
    let altValueStart = -1;
    let altValueEnd = -1;
    let altQuote: AttrQuote = '';
    if (altRaw !== undefined) {
      const attrLoc = loc.attrs?.['alt'];
      if (attrLoc) {
        const span = findAttrValueSpan(body, attrLoc);
        if (span) {
          altValueStart = span.valueStart;
          altValueEnd = span.valueEnd;
          altQuote = span.quote;
        }
      }
    }

    out.push({
      src,
      rule,
      tag_start: tagStart,
      tag_end: tagEnd,
      alt_value_start: altValueStart,
      alt_value_end: altValueEnd,
      alt_quote: altQuote,
      context_before: snippet(body, tagStart - CONTEXT_CHARS, tagStart),
      context_after: snippet(body, tagEnd, tagEnd + CONTEXT_CHARS),
      not_editable:
        rule !== undefined && rule !== 'D1' && altValueStart === -1 ? true : undefined,
    });
  });

  return out;
}

/** Backwards-compatible: only flagged imgs (rule defined). */
export function extractImages(body: string): ExtractedImage[] {
  return extractAllImages(body).filter((im) => im.rule !== undefined);
}

/** Total `<img>` count regardless of alt status — used for the headline (`X missing / Y total`). */
export function countAllImages(body: string): number {
  const fragment = parseBody(body);
  let n = 0;
  walk(fragment, (el) => {
    if (el.tagName === 'img') n++;
  });
  return n;
}
