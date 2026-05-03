import { parseFragment, defaultTreeAdapter, type DefaultTreeAdapterMap } from 'parse5';
import type { AttrQuote } from '../../host/surgical-edit.js';

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];
type Text = DefaultTreeAdapterMap['textNode'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

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

interface HrefSpan {
  valueStart: number;
  valueEnd: number;
  quote: AttrQuote;
}

function findHrefSpan(
  body: string,
  attrLoc: { startOffset: number; endOffset: number },
): HrefSpan | undefined {
  const slice = body.slice(attrLoc.startOffset, attrLoc.endOffset);
  const eq = slice.indexOf('=');
  if (eq === -1) return undefined;
  let i = eq + 1;
  while (i < slice.length && /\s/.test(slice[i] ?? '')) i++;
  if (i >= slice.length) return undefined;
  const c = slice[i];
  if (c === '"' || c === "'") {
    const valueStart = attrLoc.startOffset + i + 1;
    const close = slice.indexOf(c, i + 1);
    if (close === -1) return undefined;
    const valueEnd = attrLoc.startOffset + close;
    return { valueStart, valueEnd, quote: c };
  }
  return {
    valueStart: attrLoc.startOffset + i,
    valueEnd: attrLoc.endOffset,
    quote: '',
  };
}

function isElement(node: Node): node is Element {
  return 'tagName' in node && Array.isArray((node as Element).childNodes);
}

function isTextNode(node: Node): node is Text {
  return (node as Text).nodeName === '#text' && typeof (node as Text).value === 'string';
}

function getAttr(el: Element, name: string): string | undefined {
  for (const a of el.attrs) {
    if (a.name === name) return a.value;
  }
  return undefined;
}

function collectText(node: Node): string {
  if (isTextNode(node)) return node.value;
  if ('childNodes' in node) {
    let out = '';
    for (const c of (node as ParentNode).childNodes) out += collectText(c);
    return out;
  }
  return '';
}

function walk(node: Node, visit: (el: Element) => void): void {
  if (isElement(node)) visit(node);
  if ('childNodes' in node) {
    for (const c of (node as ParentNode).childNodes) walk(c, visit);
  }
}

export function extractAnchors(body: string): ExtractedLink[] {
  const fragment = parseFragment(body, {
    sourceCodeLocationInfo: true,
    treeAdapter: defaultTreeAdapter,
  });
  const out: ExtractedLink[] = [];

  walk(fragment as unknown as Node, (el) => {
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

    const span = findHrefSpan(body, attrLoc);
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
