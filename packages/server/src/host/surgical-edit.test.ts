import { describe, it, expect } from 'vitest';
import {
  spliceHrefValue,
  removeAnchorPreserveText,
  encodeForAttr,
  UneditableUrlError,
} from './surgical-edit.js';
import { extractAnchors } from '../plugins/broken-links/extract.js';

function findAttr(text: string, name: string): { start: number; end: number; quote: '"' | "'" | '' } {
  const re = new RegExp(`${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`);
  const m = re.exec(text);
  if (!m) throw new Error(`attr ${name} not found`);
  const fullStart = m.index + m[0].indexOf('=');
  const after = text.slice(fullStart + 1);
  const ws = after.match(/^\s*/)?.[0].length ?? 0;
  const valStart = fullStart + 1 + ws;
  const c = text[valStart];
  if (c === '"' || c === "'") {
    const close = text.indexOf(c, valStart + 1);
    return { start: valStart + 1, end: close, quote: c };
  }
  // unquoted
  const tail = text.slice(valStart).match(/^[^\s>]+/);
  if (!tail) throw new Error('cannot locate unquoted value');
  return { start: valStart, end: valStart + tail[0].length, quote: '' };
}

describe('encodeForAttr', () => {
  it('escapes & and " for double-quoted', () => {
    expect(encodeForAttr('https://x.test/?a=1&b=2', '"')).toBe('https://x.test/?a=1&amp;b=2');
    expect(encodeForAttr('hi "there"', '"')).toBe('hi &quot;there&quot;');
  });
  it('escapes & and \' for single-quoted', () => {
    expect(encodeForAttr("a&b'c", "'")).toBe('a&amp;b&#39;c');
  });
  it('rejects whitespace in unquoted', () => {
    expect(() => encodeForAttr('a b', '')).toThrow(UneditableUrlError);
  });
});

describe('AC1, AC2: surgical replace preserves all bytes outside href value', () => {
  const cases = [
    `<a href="https://old.test/" rel="nofollow ugc" target="_blank" class="external" data-foo="bar">click</a>`,
    `<a class="link"\n   rel="noopener"\n   href="https://old.test/page"\n   target="_blank">multi-line</a>`,
    `<a href='https://old.test/single'>single quoted</a>`,
    `<a href="https://old.test/?a=1&amp;b=2" rel="ugc">amp encoded</a>`,
  ];

  for (const html of cases) {
    it(`replaces only the href value: ${html.slice(0, 40)}...`, () => {
      const span = findAttr(html, 'href');
      const out = spliceHrefValue({
        text: html,
        hrefValueStart: span.start,
        hrefValueEnd: span.end,
        hrefQuote: span.quote,
        newHref: 'https://new.test/x',
      });
      // The new text differs only in the href value range
      const before = html.slice(0, span.start);
      const after = html.slice(span.end);
      expect(out.startsWith(before)).toBe(true);
      expect(out.endsWith(after)).toBe(true);
      // The substituted region equals the encoded new href
      const middle = out.slice(before.length, out.length - after.length);
      expect(middle).toBe('https://new.test/x');
    });
  }

  it('replace via parse5-extracted offsets keeps all attributes verbatim', () => {
    const body =
      `<p>before</p>\n<a rel="nofollow ugc" target="_blank" class="external" data-foo="bar" href="https://old.test/x">click</a>\n<p>after</p>`;
    const links = extractAnchors(body);
    expect(links).toHaveLength(1);
    const link = links[0]!;
    const out = spliceHrefValue({
      text: body,
      hrefValueStart: link.href_value_start,
      hrefValueEnd: link.href_value_end,
      hrefQuote: link.href_quote,
      newHref: 'https://new.test/y',
    });
    expect(out).toContain('rel="nofollow ugc"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('class="external"');
    expect(out).toContain('data-foo="bar"');
    expect(out).toContain('href="https://new.test/y"');
    expect(out).not.toContain('https://old.test/x');
    // Bytes before tagStart and after tagEnd unchanged
    const beforeTag = body.slice(0, link.tag_start);
    const afterTag = body.slice(link.tag_end);
    expect(out.startsWith(beforeTag)).toBe(true);
    expect(out.endsWith(afterTag)).toBe(true);
  });
});

describe('AC3: remove preserves inner HTML byte-identical', () => {
  it('removes <a> wrapper, keeping nested <em>', () => {
    const body = `<p>before</p><a href="https://old.test/x">some <em>fancy</em> text</a><p>after</p>`;
    const links = extractAnchors(body);
    const link = links[0]!;
    const out = removeAnchorPreserveText({
      text: body,
      tagStart: link.tag_start,
      innerStart: link.inner_start,
      innerEnd: link.inner_end,
      tagEnd: link.tag_end,
    });
    expect(out).toBe(`<p>before</p>some <em>fancy</em> text<p>after</p>`);
  });

  it('removes empty anchor cleanly', () => {
    const body = `start<a href="https://x">x</a>end`;
    const links = extractAnchors(body);
    const link = links[0]!;
    const out = removeAnchorPreserveText({
      text: body,
      tagStart: link.tag_start,
      innerStart: link.inner_start,
      innerEnd: link.inner_end,
      tagEnd: link.tag_end,
    });
    expect(out).toBe(`startxend`);
  });
});
