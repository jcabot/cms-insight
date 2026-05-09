import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApplyContext } from '../../host/apply.js';
import { FsPluginStorage } from '../../host/plugin-storage.js';
import { hashBytes } from '../../host/hash.js';
import { parseFile } from '../../content/frontmatter.js';
import { applyAction } from './apply.js';
import { extractImages } from './extract.js';
import { saveSidecar, SCHEMA_VERSION, type AltFinding, type PostSidecar } from './sidecar.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cmsi-alt-apply-'));
}

const FRONTMATTER = `---
type: post
slug: hello
title: Hello
status: publish
date_gmt: '2026-01-01T00:00:00'
modified_gmt: '2026-01-01T00:00:00'
---

`;

interface Setup {
  dir: string;
  storage: FsPluginStorage;
  ctx: ReturnType<typeof createApplyContext>;
  sidecar: PostSidecar;
  fullText: string;
}

async function setup(htmlBody: string): Promise<Setup> {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
  await fs.mkdir(path.join(dir, '.cmsinsight', 'missing-alt-text'), { recursive: true });
  const fullText = FRONTMATTER + htmlBody + '\n';
  await fs.writeFile(path.join(dir, 'posts', 'hello.html'), fullText, 'utf8');

  const parsed = parseFile(fullText);
  const bodyHash = hashBytes(Buffer.from(parsed.body, 'utf8'));

  const imgs = extractImages(parsed.body);
  const findings: AltFinding[] = imgs.map((im, i) => ({
    id: `f-${i}`,
    src: im.src,
    rule: im.rule,
    status: 'open',
    tag_start: im.tag_start,
    tag_end: im.tag_end,
    alt_value_start: im.alt_value_start,
    alt_value_end: im.alt_value_end,
    alt_quote: im.alt_quote,
    context_before: im.context_before,
    context_after: im.context_after,
  }));

  const sidecar: PostSidecar = {
    schema_version: SCHEMA_VERSION,
    post_id: undefined,
    type: 'post',
    slug: 'hello',
    file_path: 'posts/hello.html',
    body_hash: bodyHash,
    last_scanned: new Date().toISOString(),
    findings,
  };

  const storage = new FsPluginStorage(path.join(dir, '.cmsinsight', 'missing-alt-text'));
  await saveSidecar(storage, sidecar);
  const ctx = createApplyContext({ contentDir: dir, storage });
  return { dir, storage, ctx, sidecar, fullText };
}

describe('missing-alt-text apply', () => {
  let s: Setup;

  describe('AC4: byte-perfect rewrites', () => {
    it('inserts alt for D1 with all surrounding bytes preserved', async () => {
      const html = `<p>before</p><img src="a.png" class="logo" data-foo="bar"><p>after</p>`;
      s = await setup(html);
      const finding = s.sidecar.findings[0]!;
      expect(finding.rule).toBe('D1');

      const result = await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [{ postType: 'post', slug: 'hello', findingId: finding.id, altText: 'company logo' }],
      });
      expect(result.ok).toBe(true);

      const after = await fs.readFile(path.join(s.dir, 'posts', 'hello.html'), 'utf8');
      const expected =
        FRONTMATTER +
        `<p>before</p><img alt="company logo" src="a.png" class="logo" data-foo="bar"><p>after</p>` +
        '\n';
      expect(after).toBe(expected);
    });

    it('replaces empty alt for D3 in place', async () => {
      const html = `<p>x</p><img src="a.png" alt="" width="640"><p>y</p>`;
      s = await setup(html);
      const finding = s.sidecar.findings[0]!;
      expect(finding.rule).toBe('D3');

      const result = await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [{ postType: 'post', slug: 'hello', findingId: finding.id, altText: 'team photo' }],
      });
      expect(result.ok).toBe(true);

      const after = await fs.readFile(path.join(s.dir, 'posts', 'hello.html'), 'utf8');
      expect(after).toContain(`<img src="a.png" alt="team photo" width="640">`);
    });

    it('replaces whitespace-only alt for D2', async () => {
      const html = `<img src="a.png" alt="  ">`;
      s = await setup(html);
      const finding = s.sidecar.findings[0]!;
      expect(finding.rule).toBe('D2');

      await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [{ postType: 'post', slug: 'hello', findingId: finding.id, altText: 'real alt' }],
      });

      const after = await fs.readFile(path.join(s.dir, 'posts', 'hello.html'), 'utf8');
      expect(after).toContain(`<img src="a.png" alt="real alt">`);
    });
  });

  describe('AC5: single-alt invariant', () => {
    it('post-rewrite parse confirms exactly one alt attribute (D1 case)', async () => {
      const html = `<img src="a.png">`;
      s = await setup(html);
      const finding = s.sidecar.findings[0]!;

      await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [{ postType: 'post', slug: 'hello', findingId: finding.id, altText: 'one' }],
      });

      const after = await fs.readFile(path.join(s.dir, 'posts', 'hello.html'), 'utf8');
      // Re-parse and count alt attributes.
      const re = extractImages(parseFile(after).body);
      // After fix the img has alt=one (non-empty) so it shouldn't be flagged at all.
      expect(re).toHaveLength(0);
      // And literally only one occurrence of " alt=" in the tag.
      const matches = after.match(/\salt=/g) ?? [];
      expect(matches.length).toBe(1);
    });
  });

  describe('AC8: HTML escapes round-trip', () => {
    it('escapes &, ", <, > and re-parses to the original raw value', async () => {
      const html = `<img src="a.png">`;
      s = await setup(html);
      const finding = s.sidecar.findings[0]!;
      const raw = `She said "hi" & waved <hello> — café`;

      await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [{ postType: 'post', slug: 'hello', findingId: finding.id, altText: raw }],
      });

      const after = await fs.readFile(path.join(s.dir, 'posts', 'hello.html'), 'utf8');
      // On-disk encoding uses entity references for ", &, < and >.
      expect(after).toContain('alt="She said &quot;hi&quot; &amp; waved &lt;hello&gt; — café"');

      // parse5 round-trip yields the raw value back.
      const reparsed = parseFile(after);
      // We can't import parse5 directly here without ceremony — but we can verify by
      // walking via our own extractor. extractImages skips any img with non-empty alt,
      // so we instead use the parse5 utils directly:
      const { parseBody, walk, getAttr } = await import('../_shared/parse5-utils.js');
      let foundValue: string | undefined;
      walk(parseBody(reparsed.body), (el) => {
        if (el.tagName === 'img') foundValue = getAttr(el, 'alt');
      });
      expect(foundValue).toBe(raw);
    });
  });

  describe('multiple edits per post', () => {
    it('applies two edits in one call without offset corruption', async () => {
      const html = `<img src="a.png"><span>middle</span><img src="b.png" alt="">`;
      s = await setup(html);
      expect(s.sidecar.findings).toHaveLength(2);
      const [f1, f2] = s.sidecar.findings;

      const result = await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [
          { postType: 'post', slug: 'hello', findingId: f1!.id, altText: 'first' },
          { postType: 'post', slug: 'hello', findingId: f2!.id, altText: 'second' },
        ],
      });
      expect(result.ok).toBe(true);

      const after = await fs.readFile(path.join(s.dir, 'posts', 'hello.html'), 'utf8');
      expect(after).toContain(`<img alt="first" src="a.png">`);
      expect(after).toContain(`<img src="b.png" alt="second">`);
    });
  });

  describe('re-edit and clear', () => {
    it('lets the user edit alt text again after a fix', async () => {
      const html = `<img src="a.png" class="logo">`;
      s = await setup(html);
      const finding = s.sidecar.findings[0]!;

      // First apply: D1 → fixed
      await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [{ postType: 'post', slug: 'hello', findingId: finding.id, altText: 'first' }],
      });

      // Sidecar now has applied_alt='first', refreshed offsets, status='fixed'.
      const { loadSidecar } = await import('./sidecar.js');
      const sc1 = (await loadSidecar(s.storage, 'post', 'hello'))!;
      expect(sc1.findings).toHaveLength(1);
      expect(sc1.findings[0]!.applied_alt).toBe('first');
      expect(sc1.findings[0]!.status).toBe('fixed');
      expect(sc1.findings[0]!.alt_value_start).toBeGreaterThan(0);

      // Second apply: change to 'second'. Should splice (since alt now exists), not insert.
      const result = await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [{ postType: 'post', slug: 'hello', findingId: finding.id, altText: 'second' }],
      });
      expect(result.ok).toBe(true);

      const after = await fs.readFile(path.join(s.dir, 'posts', 'hello.html'), 'utf8');
      // Exactly one alt attribute, value='second'.
      const matches = after.match(/\salt="([^"]*)"/g) ?? [];
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(' alt="second"');
      expect(after).not.toContain('alt="first"');

      const sc2 = (await loadSidecar(s.storage, 'post', 'hello'))!;
      expect(sc2.findings[0]!.applied_alt).toBe('second');
    });

    it('clears the fix when the user submits an empty alt', async () => {
      const html = `<img src="a.png">`;
      s = await setup(html);
      const finding = s.sidecar.findings[0]!;

      await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [{ postType: 'post', slug: 'hello', findingId: finding.id, altText: 'logo' }],
      });

      // Clear: empty altText → file gets alt="", finding back to 'open' / D3.
      const result = await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [{ postType: 'post', slug: 'hello', findingId: finding.id, altText: '' }],
      });
      expect(result.ok).toBe(true);

      const after = await fs.readFile(path.join(s.dir, 'posts', 'hello.html'), 'utf8');
      // alt was inserted right after <img on the first apply, so it stays there for the clear.
      expect(after).toContain('<img alt="" src="a.png">');

      const { loadSidecar } = await import('./sidecar.js');
      const sc = (await loadSidecar(s.storage, 'post', 'hello'))!;
      expect(sc.findings).toHaveLength(1);
      expect(sc.findings[0]!.applied_alt).toBeUndefined();
      expect(sc.findings[0]!.status).toBe('open');
      expect(sc.findings[0]!.rule).toBe('D3');
    });
  });

  describe('AC6: stale-hash guard', () => {
    it('rejects when the file changes externally between extract and apply', async () => {
      const html = `<img src="a.png">`;
      s = await setup(html);
      // External edit shifts bytes around the tag.
      const onDisk = await fs.readFile(path.join(s.dir, 'posts', 'hello.html'), 'utf8');
      await fs.writeFile(
        path.join(s.dir, 'posts', 'hello.html'),
        onDisk.replace('<img src="a.png">', '<p>moved</p><img src="a.png">'),
        'utf8',
      );

      const result = await applyAction(s.ctx, {
        kind: 'set-alt',
        edits: [
          { postType: 'post', slug: 'hello', findingId: s.sidecar.findings[0]!.id, altText: 'x' },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/body hash mismatch/);
    });
  });
});
