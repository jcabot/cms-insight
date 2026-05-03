import { describe, it, expect } from 'vitest';
import { classify, loadDefaultRules } from './rules.js';

describe('AC8: soft 404 detection', () => {
  it('flags status 200 with "Page Not Found" in title', async () => {
    const rules = await loadDefaultRules();
    const out = classify(
      {
        status: 200,
        finalUrl: 'https://x.test/foo',
        originalHref: 'https://x.test/foo',
        body: '<html><head><title>Page Not Found</title></head><body><p>Sorry</p></body></html>',
        contentType: 'text/html',
        crossDomainRedirect: false,
        anchorText: 'click',
      },
      rules,
    );
    expect(out.verdict).toBe('BROKEN');
    expect(out.reason_code).toBe('soft_404');
  });

  it('flags h1 saying no longer available', async () => {
    const rules = await loadDefaultRules();
    const out = classify(
      {
        status: 200,
        finalUrl: 'https://x.test/foo',
        originalHref: 'https://x.test/foo',
        body: '<html><h1>This article is no longer available</h1></html>',
        contentType: 'text/html',
        crossDomainRedirect: false,
        anchorText: 'a',
      },
      rules,
    );
    expect(out.verdict).toBe('BROKEN');
    expect(out.reason_code).toBe('soft_404');
  });

  it('does not flag normal pages', async () => {
    const rules = await loadDefaultRules();
    const out = classify(
      {
        status: 200,
        finalUrl: 'https://x.test/',
        originalHref: 'https://x.test/',
        body: '<html><title>Home</title><body><p>Welcome</p></body></html>',
        contentType: 'text/html',
        crossDomainRedirect: false,
        anchorText: 'home',
      },
      rules,
    );
    expect(out.verdict).toBe('OK');
  });
});

describe('AC7: parking detection', () => {
  it('flags Sedo parking', async () => {
    const rules = await loadDefaultRules();
    const out = classify(
      {
        status: 200,
        finalUrl: 'https://example.com/',
        originalHref: 'https://example.com/',
        body:
          '<html><body><script src="https://sedoparking.com/js/loader.js"></script></body></html>',
        contentType: 'text/html',
        crossDomainRedirect: false,
        anchorText: 'a',
      },
      rules,
    );
    expect(out.verdict).toBe('BROKEN');
    expect(out.reason_code).toBe('parked_sedo');
  });

  it('flags GoDaddy parking', async () => {
    const rules = await loadDefaultRules();
    const out = classify(
      {
        status: 200,
        finalUrl: 'https://example.com/',
        originalHref: 'https://example.com/',
        body: '<html><body><iframe src="https://lpc.godaddy.com/lpc/x"></iframe></body></html>',
        contentType: 'text/html',
        crossDomainRedirect: false,
        anchorText: 'a',
      },
      rules,
    );
    expect(out.verdict).toBe('BROKEN');
    expect(out.reason_code).toBe('parked_godaddy_parking');
  });

  it('flags generic parking signal on small page', async () => {
    const rules = await loadDefaultRules();
    const out = classify(
      {
        status: 200,
        finalUrl: 'https://example.com/',
        originalHref: 'https://example.com/',
        body: '<html><body><h1>This domain is for sale</h1><p>Contact us.</p></body></html>',
        contentType: 'text/html',
        crossDomainRedirect: false,
        anchorText: 'a',
      },
      rules,
    );
    expect(out.verdict).toBe('BROKEN');
    expect(out.reason_code).toBe('parked_generic');
  });
});

describe('Topic-shift detection', () => {
  it('flags gambling content density when anchor is unrelated', async () => {
    const rules = await loadDefaultRules();
    const body = `<html><body><h1>Best casino bonus</h1>` +
      Array(50).fill('casino slots betting poker bonus code sportsbook free spins').join(' ') +
      `</body></html>`;
    const out = classify(
      {
        status: 200,
        finalUrl: 'https://gambling.test/',
        originalHref: 'https://example.com/',
        body,
        contentType: 'text/html',
        crossDomainRedirect: true,
        anchorText: 'old article',
      },
      rules,
    );
    expect(out.verdict).toBe('SUSPICIOUS');
    expect(out.reason_code).toBe('topic_shift_gambling');
  });

  it('does NOT flag gambling when anchor is gambling-related', async () => {
    const rules = await loadDefaultRules();
    const body = `<html><body><h1>Best casino bonus</h1>` +
      Array(50).fill('casino slots betting poker bonus code sportsbook free spins').join(' ') +
      `</body></html>`;
    const out = classify(
      {
        status: 200,
        finalUrl: 'https://gambling.test/',
        originalHref: 'https://example.com/',
        body,
        contentType: 'text/html',
        crossDomainRedirect: false,
        anchorText: 'best online casino',
      },
      rules,
    );
    expect(out.verdict).toBe('OK');
  });
});
