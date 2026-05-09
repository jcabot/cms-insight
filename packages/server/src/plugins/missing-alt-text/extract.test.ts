import { describe, it, expect } from 'vitest';
import { extractImages, countAllImages } from './extract.js';

describe('extractImages', () => {
  it('flags <img> without alt as D1', () => {
    const body = `<p>x</p><img src="a.png"><p>y</p>`;
    const imgs = extractImages(body);
    expect(imgs).toHaveLength(1);
    const im = imgs[0]!;
    expect(im.rule).toBe('D1');
    expect(im.src).toBe('a.png');
    expect(im.alt_value_start).toBe(-1);
    expect(body.slice(im.tag_start, im.tag_end)).toBe('<img src="a.png">');
  });

  it('flags <img alt=""> as D3', () => {
    const body = `<img src="a.png" alt="">`;
    const im = extractImages(body)[0]!;
    expect(im.rule).toBe('D3');
    expect(im.alt_quote).toBe('"');
    expect(body.slice(im.alt_value_start, im.alt_value_end)).toBe('');
  });

  it('flags <img alt=" "> as D2 (whitespace only)', () => {
    const body = `<img src="a.png" alt="  \t ">`;
    const im = extractImages(body)[0]!;
    expect(im.rule).toBe('D2');
    expect(body.slice(im.alt_value_start, im.alt_value_end)).toBe('  \t ');
  });

  it('does not flag a non-empty alt', () => {
    const body = `<img src="a.png" alt="logo">`;
    expect(extractImages(body)).toHaveLength(0);
  });

  it('handles self-closing <img/> with no alt', () => {
    const body = `<img src="a.png" />`;
    const im = extractImages(body)[0]!;
    expect(im.rule).toBe('D1');
    expect(body.slice(im.tag_start, im.tag_end)).toBe('<img src="a.png" />');
  });

  it('handles single-quoted alt', () => {
    const body = `<img src='a.png' alt=''>`;
    const im = extractImages(body)[0]!;
    expect(im.rule).toBe('D3');
    expect(im.alt_quote).toBe("'");
  });

  it('captures context snippets around the tag', () => {
    const body = `Hello world <img src="a.png"> there friend`;
    const im = extractImages(body)[0]!;
    expect(im.context_before).toContain('world');
    expect(im.context_after).toContain('there');
  });

  it('extracts multiple imgs in one body, in document order', () => {
    const body = `<img src="a.png"><p>x</p><img src="b.png" alt="">`;
    const imgs = extractImages(body);
    expect(imgs.map((i) => i.src)).toEqual(['a.png', 'b.png']);
    expect(imgs.map((i) => i.rule)).toEqual(['D1', 'D3']);
  });
});

describe('countAllImages', () => {
  it('counts every <img> regardless of alt', () => {
    const body = `<img src="a"><img src="b" alt="ok"><img src="c" alt="">`;
    expect(countAllImages(body)).toBe(3);
  });
});
