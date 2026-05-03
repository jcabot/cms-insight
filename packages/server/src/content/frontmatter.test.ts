import { describe, it, expect } from 'vitest';
import { parseFile } from './frontmatter.js';

describe('parseFile', () => {
  it('parses minimal post', () => {
    const text = `---\ntype: post\nslug: hi\ntitle: Hi\nstatus: publish\n---\n\n<p>body</p>\n`;
    const out = parseFile(text);
    expect(out.frontMatter.type).toBe('post');
    expect(out.frontMatter.slug).toBe('hi');
    expect(out.frontMatter.title).toBe('Hi');
    expect(out.frontMatter.status).toBe('publish');
    expect(out.body.startsWith('<p>body</p>')).toBe(true);
  });

  it('throws on missing fence', () => {
    expect(() => parseFile('not yaml')).toThrow();
  });

  it('preserves body bytes', () => {
    const body = `<p>hello</p>\n<a href="https://x.test/">l</a>\n`;
    const text = `---\ntype: post\nslug: x\ntitle: X\nstatus: publish\n---\n\n${body}`;
    const out = parseFile(text);
    expect(out.body).toBe(body);
  });
});
