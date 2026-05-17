import type { LlmImageInput } from '@cms-insight/plugin-api';

const SUPPORTED: Record<string, LlmImageInput['mediaType']> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

const MAX_BYTES = 5 * 1024 * 1024;

export interface FetchImageResult {
  ok: true;
  image: LlmImageInput;
}

export interface FetchImageFailure {
  ok: false;
  reason: string;
}

export function resolveImageUrl(src: string, siteUrl: string): string | undefined {
  if (!src) return undefined;
  if (src.startsWith('data:')) return undefined;
  if (/^https?:\/\//i.test(src)) return src;
  if (/^\/\//.test(src)) return `https:${src}`;
  if (src.startsWith('/')) {
    try {
      return new URL(src, siteUrl).toString();
    } catch {
      return undefined;
    }
  }
  // Relative path — best-effort against siteUrl.
  try {
    return new URL(src, siteUrl.endsWith('/') ? siteUrl : siteUrl + '/').toString();
  } catch {
    return undefined;
  }
}

export async function fetchImage(
  url: string,
  signal: AbortSignal,
  userAgent: string,
): Promise<FetchImageResult | FetchImageFailure> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal,
      headers: { 'user-agent': userAgent, accept: 'image/*' },
      redirect: 'follow',
    });
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${(err as Error).message}` };
  }
  if (!resp.ok) {
    return { ok: false, reason: `http ${resp.status}` };
  }
  const rawType = (resp.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  const mediaType = rawType ? SUPPORTED[rawType] : undefined;
  if (!mediaType) {
    return { ok: false, reason: `unsupported content-type: ${rawType || 'unknown'}` };
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    return { ok: false, reason: `image too large (${buf.byteLength} bytes)` };
  }
  return {
    ok: true,
    image: { mediaType, dataBase64: buf.toString('base64') },
  };
}
