import { getDomain } from 'tldts';

export function isSkippable(href: string): boolean {
  if (!href) return true;
  const trimmed = href.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('mailto:')) return true;
  if (lower.startsWith('tel:')) return true;
  if (lower.startsWith('javascript:')) return true;
  if (lower.startsWith('#')) return true;
  if (lower.startsWith('//')) return false;
  if (!/^[a-z][a-z0-9+\-.]*:/.test(lower)) return true;
  return !/^https?:/.test(lower);
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
