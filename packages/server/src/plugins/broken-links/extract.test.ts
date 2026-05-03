import { describe, it, expect } from 'vitest';
import { extractAnchors } from './extract.js';

describe('extractAnchors', () => {
  it('extracts a basic anchor with offsets', () => {
    const body = `<p>x</p><a href="https://x.test/">click</a><p>y</p>`;
    const links = extractAnchors(body);
    expect(links).toHaveLength(1);
    const l = links[0]!;
    expect(l.href).toBe('https://x.test/');
    expect(l.anchor_text).toBe('click');
    expect(l.href_quote).toBe('"');
    expect(body.slice(l.href_value_start, l.href_value_end)).toBe('https://x.test/');
    expect(body.slice(l.tag_start, l.tag_end)).toBe('<a href="https://x.test/">click</a>');
    expect(body.slice(l.inner_start, l.inner_end)).toBe('click');
  });

  it('handles single quotes', () => {
    const body = `<a href='https://x.test/'>x</a>`;
    const l = extractAnchors(body)[0]!;
    expect(l.href_quote).toBe("'");
    expect(body.slice(l.href_value_start, l.href_value_end)).toBe('https://x.test/');
  });

  it('preserves all attributes for editing', () => {
    const body =
      `<a class="ext" rel="nofollow ugc" target="_blank" href="https://x.test/" data-foo="bar">click</a>`;
    const l = extractAnchors(body)[0]!;
    expect(l.href).toBe('https://x.test/');
    // The href value span should land precisely on the URL
    expect(body.slice(l.href_value_start, l.href_value_end)).toBe('https://x.test/');
  });

  it('extracts nested anchor inner text', () => {
    const body = `<a href="https://x.test/">some <em>fancy</em> text</a>`;
    const l = extractAnchors(body)[0]!;
    expect(body.slice(l.inner_start, l.inner_end)).toBe('some <em>fancy</em> text');
  });
});
