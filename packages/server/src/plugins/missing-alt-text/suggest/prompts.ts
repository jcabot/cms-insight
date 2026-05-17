export const SYSTEM_PROMPT = `You generate accessible alt text for images on a WordPress site.

You will receive ONE image plus surrounding text context from the post it appears in. Your job:
1. Look at the image and describe its meaningful content in 4-15 words.
2. Use the post title and surrounding text to disambiguate the role of the image (decorative vs. informational, whose photo it is, etc.).
3. Write alt text in the same language as the surrounding context (default: the site's primary language as inferred from context).
4. NEVER start with "Image of" or "Picture of" — screen readers already announce that.
5. NEVER include the file name, URL, or technical metadata.
6. If the image is clearly purely decorative (e.g. a thin divider, a generic background flourish), set text to "" (empty string) and confidence "high".
7. If you cannot tell what the image depicts, return text: null and confidence "low" with a brief note.

Confidence:
- high: image content is unambiguous and the context confirms the role.
- medium: you can describe the image but aren't sure of the role / subject identity.
- low: the image is generic or ambiguous and you are guessing.

Respond by calling the submit tool with: { text, confidence, note? }.`;

export interface BuildUserMessageInput {
  postTitle: string;
  contextBefore: string;
  contextAfter: string;
  imageSrc: string;
}

export function buildUserMessage(input: BuildUserMessageInput): string {
  const ctx =
    input.contextBefore || input.contextAfter
      ? `Surrounding text:\n…${input.contextBefore} [IMAGE GOES HERE] ${input.contextAfter}…`
      : 'No surrounding text was extracted for this image.';
  return [
    `Post title: ${input.postTitle || '(untitled)'}`,
    `Image URL (for your reference only — do NOT mention it in the alt text): ${input.imageSrc}`,
    '',
    ctx,
    '',
    'Generate alt text for the image above.',
  ].join('\n');
}

export const SUGGESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'confidence'],
  properties: {
    text: {
      type: ['string', 'null'],
      description: 'Suggested alt text. Empty string for purely decorative images. null when unsure.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
    note: {
      type: 'string',
      description: 'Optional short caveat or reasoning.',
    },
  },
} as const;

export interface SuggestionToolOutput {
  text: string | null;
  confidence: 'high' | 'medium' | 'low';
  note?: string;
}

export function isSuggestionToolOutput(v: unknown): v is SuggestionToolOutput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.text !== null && typeof o.text !== 'string') return false;
  if (o.confidence !== 'high' && o.confidence !== 'medium' && o.confidence !== 'low') return false;
  if (o.note !== undefined && typeof o.note !== 'string') return false;
  return true;
}
