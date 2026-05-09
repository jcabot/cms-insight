import type { AttrQuote } from '../../host/surgical-edit.js';
import {
  collectText,
  findAttrValueSpan,
  getAttr,
  parseBody,
  walk,
} from '../_shared/parse5-utils.js';

export interface ExtractedLink {
  href: string;
  anchor_text: string;
  tag_start: number;
  tag_end: number;
  inner_start: number;
  inner_end: number;
  href_value_start: number;
  href_value_end: number;
  href_quote: AttrQuote;
  not_editable?: boolean;
}

export function extractAnchors(body: string): ExtractedLink[] {
  const fragment = parseBody(body);
  const out: ExtractedLink[] = [];

  walk(fragment, (el) => {
    if (el.tagName !== 'a') return;
    const href = getAttr(el, 'href');
    if (href === undefined) return;

    const text = collectText(el).trim();
    const loc = el.sourceCodeLocation;

    if (!loc || !loc.startTag || !loc.attrs) {
      out.push({
        href,
        anchor_text: text,
        tag_start: -1,
        tag_end: -1,
        inner_start: -1,
        inner_end: -1,
        href_value_start: -1,
        href_value_end: -1,
        href_quote: '',
        not_editable: true,
      });
      return;
    }
    const attrLoc = loc.attrs['href'];
    const endTag = loc.endTag;

    if (!attrLoc || !endTag) {
      out.push({
        href,
        anchor_text: text,
        tag_start: loc.startOffset,
        tag_end: loc.endOffset,
        inner_start: loc.startTag.endOffset,
        inner_end: loc.endTag?.startOffset ?? loc.endOffset,
        href_value_start: -1,
        href_value_end: -1,
        href_quote: '',
        not_editable: true,
      });
      return;
    }

    const span = findAttrValueSpan(body, attrLoc);
    if (!span) {
      out.push({
        href,
        anchor_text: text,
        tag_start: loc.startTag.startOffset,
        tag_end: endTag.endOffset,
        inner_start: loc.startTag.endOffset,
        inner_end: endTag.startOffset,
        href_value_start: -1,
        href_value_end: -1,
        href_quote: '',
        not_editable: true,
      });
      return;
    }

    out.push({
      href,
      anchor_text: text,
      tag_start: loc.startTag.startOffset,
      tag_end: endTag.endOffset,
      inner_start: loc.startTag.endOffset,
      inner_end: endTag.startOffset,
      href_value_start: span.valueStart,
      href_value_end: span.valueEnd,
      href_quote: span.quote,
    });
  });

  return out;
}
