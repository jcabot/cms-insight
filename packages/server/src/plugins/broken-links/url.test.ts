import { describe, it, expect } from 'vitest';
import { isExternal, normalizeUrl, resolveCheckHref } from './url.js';

describe('resolveCheckHref', () => {
  it('resolves internal relative URLs against the site URL', () => {
    expect(resolveCheckHref('/foo', 'https://example.com/blog/')).toBe('https://example.com/foo');
    expect(resolveCheckHref('foo/bar', 'https://example.com/blog/')).toBe(
      'https://example.com/blog/foo/bar',
    );
  });

  it('keeps absolute and protocol-relative HTTP URLs checkable', () => {
    expect(resolveCheckHref('https://other.test/x', 'https://example.com/')).toBe(
      'https://other.test/x',
    );
    expect(resolveCheckHref('//example.com/x', 'https://example.com/')).toBe(
      'https://example.com/x',
    );
  });

  it('rejects non-HTTP schemes', () => {
    expect(resolveCheckHref('mailto:a@b.test', 'https://example.com/')).toBeUndefined();
    expect(resolveCheckHref('tel:+1', 'https://example.com/')).toBeUndefined();
    expect(resolveCheckHref('javascript:void(0)', 'https://example.com/')).toBeUndefined();
    expect(resolveCheckHref('ftp://example.com/file', 'https://example.com/')).toBeUndefined();
  });

  it('rejects empty and fragment-only hrefs', () => {
    expect(resolveCheckHref('', 'https://example.com/')).toBeUndefined();
    expect(resolveCheckHref('   ', 'https://example.com/')).toBeUndefined();
    expect(resolveCheckHref('#section', 'https://example.com/')).toBeUndefined();
  });
});

describe('isExternal', () => {
  it('returns true for different registrable domain', () => {
    expect(isExternal('https://other.test/x', 'https://my.example.com/')).toBe(true);
  });
  it('returns false for same registrable domain', () => {
    expect(isExternal('https://www.example.com/x', 'https://blog.example.com/')).toBe(false);
  });
  it('handles relative URLs (treated as same site)', () => {
    expect(isExternal('/foo', 'https://example.com/')).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('strips utm params', () => {
    expect(
      normalizeUrl('https://x.test/?utm_source=a&id=1', { stripParams: ['utm_source'] }),
    ).toBe('https://x.test/?id=1');
  });
  it('lowercases host', () => {
    expect(normalizeUrl('https://X.TEST/foo', { stripParams: [] })).toBe('https://x.test/foo');
  });
  it('strips default port', () => {
    expect(normalizeUrl('http://x.test:80/', { stripParams: [] })).toBe('http://x.test/');
    expect(normalizeUrl('https://x.test:443/', { stripParams: [] })).toBe('https://x.test/');
  });
});
