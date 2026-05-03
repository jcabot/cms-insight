const TAG_RE = /<[^>]*>/g;
const ENTITY_DECODE: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function stripHtml(s: string): string {
  return s
    .replace(TAG_RE, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/gi, (m) => ENTITY_DECODE[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ExtractedContext {
  before: string;
  after: string;
}

export function extractLinkContext(
  body: string,
  tagStart: number,
  tagEnd: number,
  maxChars: number,
): ExtractedContext {
  const beforeRaw = body.slice(Math.max(0, tagStart - maxChars * 2), tagStart);
  const afterRaw = body.slice(tagEnd, Math.min(body.length, tagEnd + maxChars * 2));
  let before = stripHtml(beforeRaw);
  let after = stripHtml(afterRaw);
  if (before.length > maxChars) before = '…' + before.slice(before.length - maxChars);
  if (after.length > maxChars) after = after.slice(0, maxChars) + '…';
  return { before, after };
}
