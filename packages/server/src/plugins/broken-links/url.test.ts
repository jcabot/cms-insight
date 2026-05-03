import { describe, it, expect } from 'vitest';
import { isExternal, isSkippable, normalizeUrl } from './url.js';

describe('isSkippable', () => {
  it('skips mailto/tel/javascript/fragment', () => {
    expect(isSkippable('mailto:a@b.test')).toBe(true);
    expect(isSkippable('tel:+1')).toBe(true);
    expect(isSkippable('javascript:void(0)')).toBe(true);
    expect(isSkippable('#section')).toBe(true);
  });
  it('skips relative URLs', () => {
    expect(isSkippable('/foo')).toBe(true);
    expect(isSkippable('foo/bar')).toBe(true);
  });
  it('does not skip absolute http(s)', () => {
    expect(isSkippable('https://x.test/')).toBe(false);
    expect(isSkippable('http://x.test/')).toBe(false);
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
