export type AttrQuote = '"' | "'" | '';

export class UneditableUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UneditableUrlError';
  }
}

export function encodeForAttr(value: string, quote: AttrQuote): string {
  if (quote === '"') {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
  if (quote === "'") {
    return value.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  }
  if (/[\s<>"'`=]/.test(value)) {
    throw new UneditableUrlError(
      'Cannot store URL with whitespace or special chars in an unquoted href attribute. Edit manually.',
    );
  }
  return value;
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
