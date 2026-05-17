import { getDomain } from 'tldts';

export function resolveCheckHref(href: string, siteUrl: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  // Empty and fragment-only hrefs would otherwise resolve to the site root against siteUrl.
  if (trimmed.length === 0 || trimmed.startsWith('#')) return undefined;
  try {
    const u = new URL(trimmed, siteUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export function isExternal(href: string, siteUrl: string): boolean {
  let target: URL;
  let site: URL;
  try {
    target = new URL(href, siteUrl);
    site = new URL(siteUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  const td = getDomain(target.hostname);
  const sd = getDomain(site.hostname);
  if (!td || !sd) return false;
  return td.toLowerCase() !== sd.toLowerCase();
}

export interface NormalizeOptions {
  stripParams: ReadonlyArray<string>;
}

export function normalizeUrl(href: string, opts: NormalizeOptions): string {
  try {
    const u = new URL(href);
    u.hostname = u.hostname.toLowerCase();
    if (
      (u.protocol === 'http:' && u.port === '80') ||
      (u.protocol === 'https:' && u.port === '443')
    ) {
      u.port = '';
    }
    for (const p of opts.stripParams) u.searchParams.delete(p);
    if (u.hash === '#') u.hash = '';
    return u.toString();
  } catch {
    return href;
  }
}

export function registrableDomain(href: string): string | undefined {
  try {
    const u = new URL(href);
    return getDomain(u.hostname) ?? undefined;
  } catch {
    return undefined;
  }
}

export function hostOf(href: string): string | undefined {
  try {
    const u = new URL(href);
    return u.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
