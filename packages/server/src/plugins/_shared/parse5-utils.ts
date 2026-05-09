import { parseFragment, defaultTreeAdapter, type DefaultTreeAdapterMap } from 'parse5';
import type { AttrQuote } from '../../host/surgical-edit.js';

export type Element = DefaultTreeAdapterMap['element'];
export type Node = DefaultTreeAdapterMap['node'];
export type Text = DefaultTreeAdapterMap['textNode'];
export type ParentNode = DefaultTreeAdapterMap['parentNode'];

export interface AttrValueSpan {
  valueStart: number;
  valueEnd: number;
  quote: AttrQuote;
}

/** Locate the byte span of an attribute's value within `body`, given the parse5 attr location. */
export function findAttrValueSpan(
  body: string,
  attrLoc: { startOffset: number; endOffset: number },
): AttrValueSpan | undefined {
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

export function isElement(node: Node): node is Element {
  return 'tagName' in node && Array.isArray((node as Element).childNodes);
}

export function isTextNode(node: Node): node is Text {
  return (node as Text).nodeName === '#text' && typeof (node as Text).value === 'string';
}

export function getAttr(el: Element, name: string): string | undefined {
  for (const a of el.attrs) {
    if (a.name === name) return a.value;
  }
  return undefined;
}

export function collectText(node: Node): string {
  if (isTextNode(node)) return node.value;
  if ('childNodes' in node) {
    let out = '';
    for (const c of (node as ParentNode).childNodes) out += collectText(c);
    return out;
  }
  return '';
}

export function walk(node: Node, visit: (el: Element) => void): void {
  if (isElement(node)) visit(node);
  if ('childNodes' in node) {
    for (const c of (node as ParentNode).childNodes) walk(c, visit);
  }
}

export function parseBody(body: string): Node {
  return parseFragment(body, {
    sourceCodeLocationInfo: true,
    treeAdapter: defaultTreeAdapter,
  }) as unknown as Node;
}
