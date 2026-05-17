import { describe, expect, it } from 'vitest';
import { buildLinkRecords } from './build-records.js';

describe('buildLinkRecords', () => {
  it('includes external and internal links that can be checked over HTTP(S)', () => {
    const body = [
      '<a href="https://other.test/">external</a>',
      '<a href="https://example.com/about">same-domain absolute</a>',
      '<a href="/contact">root relative</a>',
      '<a href="docs/page">relative</a>',
      '<a href="//example.com/protocol">protocol relative</a>',
    ].join('');

    const records = buildLinkRecords({
      body,
      bodyHash: 'h',
      postId: 1,
      siteUrl: 'https://example.com/blog/',
      stripParams: [],
    });

    expect(records.map((r) => r.href)).toEqual([
      'https://other.test/',
      'https://example.com/about',
      '/contact',
      'docs/page',
      '//example.com/protocol',
    ]);
  });

  it('skips links that are not useful for broken-link checking', () => {
    const body = [
      '<a href="#top">fragment</a>',
      '<a href="mailto:a@b.test">mail</a>',
      '<a href="tel:+1">phone</a>',
      '<a href="javascript:void(0)">script</a>',
      '<a href="ftp://example.com/file">ftp</a>',
    ].join('');

    const records = buildLinkRecords({
      body,
      bodyHash: 'h',
      postId: 1,
      siteUrl: 'https://example.com/',
      stripParams: [],
    });

    expect(records).toHaveLength(0);
  });
});
