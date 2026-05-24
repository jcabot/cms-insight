import { describe, expect, it } from 'vitest';
import {
  buildNodeIndex,
  extractOutgoing,
  normalizeSlug,
  resolveTarget,
  type IndexablePost,
} from './resolve.js';

const SITE = 'https://example.com';

const POSTS: IndexablePost[] = [
  { id: 1, type: 'post', slug: 'hello-world' },
  { id: 2, type: 'post', slug: 'second-post' },
  { id: 3, type: 'post', slug: 'third-post' },
  { id: 100, type: 'page', slug: 'about' },
];

const index = buildNodeIndex(POSTS);

describe('resolveTarget', () => {
  it('AC1: relative and absolute hrefs to the same post resolve to one node', () => {
    const rel = resolveTarget('/second-post/', SITE, index);
    const abs = resolveTarget('https://example.com/second-post/', SITE, index);
    expect(rel?.id).toBe('post:second-post');
    expect(abs?.id).toBe('post:second-post');
    expect(rel?.id).toBe(abs?.id);
  });

  it('matches www vs apex and http vs https as the same site', () => {
    expect(resolveTarget('https://www.example.com/second-post/', SITE, index)?.id).toBe(
      'post:second-post',
    );
    expect(resolveTarget('http://example.com/second-post', SITE, index)?.id).toBe(
      'post:second-post',
    );
  });

  it('resolves query-id permalinks via post id', () => {
    expect(resolveTarget('https://example.com/?p=2', SITE, index)?.id).toBe('post:second-post');
    expect(resolveTarget('/?page_id=100', SITE, index)?.id).toBe('page:about');
  });

  it('AC5: a same-site URL with no matching post resolves to nothing', () => {
    expect(resolveTarget('https://example.com/category/notes/', SITE, index)).toBeUndefined();
    expect(resolveTarget('/', SITE, index)).toBeUndefined();
  });

  it('AC6: external domains resolve to nothing', () => {
    expect(resolveTarget('https://other.test/second-post/', SITE, index)).toBeUndefined();
  });

  it('drops fragment-only and non-http(s) hrefs', () => {
    expect(resolveTarget('#section', SITE, index)).toBeUndefined();
    expect(resolveTarget('mailto:a@b.test', SITE, index)).toBeUndefined();
  });

  it('AC10: a link to an unpublished post (absent from the index) resolves to nothing', () => {
    const published = buildNodeIndex(POSTS); // draft-post deliberately omitted
    expect(resolveTarget('/draft-post/', SITE, published)).toBeUndefined();
  });
});

describe('extractOutgoing', () => {
  it('AC1 + AC2: relative and absolute anchors to one target collapse to a single edge', () => {
    const body =
      '<a href="/second-post/">see also</a> ' +
      '<a href="https://example.com/second-post/">more</a>';
    const out = extractOutgoing('post', 'third-post', body, SITE, index);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ target_type: 'post', target_slug: 'second-post' });
    expect(out[0]?.anchors).toEqual(['see also', 'more']);
  });

  it('AC7: self-links are dropped', () => {
    const out = extractOutgoing('post', 'third-post', '<a href="/third-post/">me</a>', SITE, index);
    expect(out).toHaveLength(0);
  });

  it('AC6: external links contribute no outgoing edge', () => {
    const out = extractOutgoing(
      'post',
      'third-post',
      '<a href="https://en.wikipedia.org/wiki/X">x</a>',
      SITE,
      index,
    );
    expect(out).toHaveLength(0);
  });

  it('collects multiple distinct targets', () => {
    const body = '<a href="/second-post/">a</a><a href="/?p=1">b</a>';
    const out = extractOutgoing('page', 'about', body, SITE, index);
    expect(out.map((o) => `${o.target_type}:${o.target_slug}`).sort()).toEqual([
      'post:hello-world',
      'post:second-post',
    ]);
  });
});

describe('normalizeSlug', () => {
  it('lower-cases, trims slashes, and decodes percent-escapes', () => {
    expect(normalizeSlug('/Hello-World/')).toBe('hello-world');
    expect(normalizeSlug('caf%C3%A9')).toBe('café');
  });
});
