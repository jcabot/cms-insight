export type AttrQuote = '"' | "'" | '';

export class UneditableUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UneditableUrlError';
  }
}

export function encodeForAttr(value: string, quote: AttrQuote): string {
  // Always escape & first, then chars whose presence inside a quoted attribute is risky:
  // the matching quote char, newlines (which would prematurely close the value in some
  // contexts and harm readability), and `<` / `>` (defensive — never emit raw angle
  // brackets inside an attribute value, per HTML hardening guidance).
  const baseEscaped = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
  if (quote === '"') {
    return baseEscaped.replace(/"/g, '&quot;');
  }
  if (quote === "'") {
    return baseEscaped.replace(/'/g, '&#39;');
  }
  if (/[\s<>"'`=]/.test(value)) {
    throw new UneditableUrlError(
      'Cannot store URL with whitespace or special chars in an unquoted href attribute. Edit manually.',
    );
  }
  return baseEscaped;
}

export interface SpliceHrefOptions {
  /** The full text being edited (e.g. file contents or body string). */
  text: string;
  /** Offset where the href value begins (just after the opening quote, or the value start if unquoted). */
  hrefValueStart: number;
  /** Offset where the href value ends (just before the closing quote, or end of value if unquoted). */
  hrefValueEnd: number;
  /** The quote character surrounding the href value, or '' if unquoted. */
  hrefQuote: AttrQuote;
  /** The replacement URL (raw, will be HTML-attribute-escaped). */
  newHref: string;
}

export function spliceHrefValue(opts: SpliceHrefOptions): string {
  if (
    opts.hrefValueStart < 0 ||
    opts.hrefValueEnd < opts.hrefValueStart ||
    opts.hrefValueEnd > opts.text.length
  ) {
    throw new Error('Invalid href value span');
  }
  const encoded = encodeForAttr(opts.newHref, opts.hrefQuote);
  return (
    opts.text.slice(0, opts.hrefValueStart) + encoded + opts.text.slice(opts.hrefValueEnd)
  );
}

export interface RemoveAnchorOptions {
  text: string;
  /** Offset where the opening `<a` begins. */
  tagStart: number;
  /** Offset where the inner content starts (just after the opening tag's `>`). */
  innerStart: number;
  /** Offset where the inner content ends (just before the `</a`). */
  innerEnd: number;
  /** Offset where the closing tag's `>` ends. */
  tagEnd: number;
}

export function removeAnchorPreserveText(opts: RemoveAnchorOptions): string {
  if (
    opts.tagStart < 0 ||
    opts.innerStart < opts.tagStart ||
    opts.innerEnd < opts.innerStart ||
    opts.tagEnd < opts.innerEnd ||
    opts.tagEnd > opts.text.length
  ) {
    throw new Error('Invalid anchor span');
  }
  const inner = opts.text.slice(opts.innerStart, opts.innerEnd);
  return opts.text.slice(0, opts.tagStart) + inner + opts.text.slice(opts.tagEnd);
}

export interface SpliceAttrValueOptions {
  text: string;
  /** Offset where the attribute value begins (just after the opening quote, or value start if unquoted). */
  valueStart: number;
  /** Offset where the attribute value ends (just before the closing quote, or end of value if unquoted). */
  valueEnd: number;
  /** The quote character surrounding the value, or '' if unquoted. */
  quote: AttrQuote;
  /** The replacement value (raw, will be HTML-attribute-escaped). */
  newValue: string;
}

/**
 * Replace an attribute's value byte-precisely, preserving the surrounding quotes and every
 * other byte in the document. Pure variant of `spliceHrefValue` for non-href attributes.
 */
export function spliceAttrValue(opts: SpliceAttrValueOptions): string {
  if (
    opts.valueStart < 0 ||
    opts.valueEnd < opts.valueStart ||
    opts.valueEnd > opts.text.length
  ) {
    throw new Error('Invalid attribute value span');
  }
  const encoded = encodeForAttr(opts.newValue, opts.quote);
  return opts.text.slice(0, opts.valueStart) + encoded + opts.text.slice(opts.valueEnd);
}

export interface InsertAttrInOpeningTagOptions {
  text: string;
  /** Offset where the opening tag's `<` begins. */
  tagStart: number;
  /** Lowercase tag name, e.g. 'img'. Used to validate the insertion point. */
  tagName: string;
  /** Attribute name to insert, e.g. 'alt'. */
  attrName: string;
  /** Raw attribute value (will be HTML-attribute-escaped). */
  attrValue: string;
  /** Quote style for the inserted value. Defaults to '"'. */
  quote?: '"' | "'";
}

/**
 * Insert ` attrName="value"` immediately after the tag name in an opening tag.
 * Used when the attribute is absent and we need to add it without disturbing
 * any other byte of the tag (other attributes, ordering, whitespace, self-closing slash).
 *
 * Verifies `<tagName` is at `tagStart` and aborts on mismatch — the caller is expected to
 * pass an offset from a parse5 `sourceCodeLocation`.
 */
export function insertAttrInOpeningTag(opts: InsertAttrInOpeningTagOptions): string {
  if (opts.tagStart < 0 || opts.tagStart > opts.text.length) {
    throw new Error('Invalid tagStart');
  }
  const expected = `<${opts.tagName}`;
  const actual = opts.text.slice(opts.tagStart, opts.tagStart + expected.length);
  if (actual.toLowerCase() !== expected) {
    throw new Error(`expected '${expected}' at offset ${opts.tagStart}, found '${actual}'`);
  }
  // Guard: the next byte must be whitespace, '>', or '/'. Otherwise we're partway through a longer tag name.
  const nextChar = opts.text[opts.tagStart + expected.length] ?? '';
  if (nextChar !== '' && !/[\s/>]/.test(nextChar)) {
    throw new Error(
      `unexpected byte after <${opts.tagName} at offset ${opts.tagStart + expected.length}: '${nextChar}'`,
    );
  }
  const insertAt = opts.tagStart + expected.length;
  const quote = opts.quote ?? '"';
  const encoded = encodeForAttr(opts.attrValue, quote);
  const insertion = ` ${opts.attrName}=${quote}${encoded}${quote}`;
  return opts.text.slice(0, insertAt) + insertion + opts.text.slice(insertAt);
}
