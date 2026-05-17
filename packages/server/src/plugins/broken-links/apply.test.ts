import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplyContext } from '../../host/apply.js';
import { hashBytes } from '../../host/hash.js';
import { FsPluginStorage } from '../../host/plugin-storage.js';
import { parseFile } from '../../content/frontmatter.js';
import { applyAction } from './apply.js';
import { buildLinkRecords } from './build-records.js';
import { loadSidecar, saveSidecar, SCHEMA_VERSION, type PostSidecar } from './sidecar.js';

const POST = `---
id: 7
type: post
slug: hello
title: Hello
status: publish
---

<p>before</p>
<a class="external" rel="nofollow ugc" target="_blank" data-foo="bar" href="https://old.test/dead">dead link</a>
<p>after</p>
`;

async function setup(): Promise<{
  dir: string;
  storage: FsPluginStorage;
  sidecar: PostSidecar;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmsi-broken-links-apply-'));
  await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
  await fs.mkdir(path.join(dir, '.cmsinsight', 'broken-links'), { recursive: true });
  await fs.writeFile(path.join(dir, 'posts', 'hello.html'), POST, 'utf8');

  const parsed = parseFile(POST);
  const bodyHash = hashBytes(parsed.body);
  const links = buildLinkRecords({
    body: parsed.body,
    bodyHash,
    postId: 7,
    siteUrl: 'https://example.com/',
    stripParams: [],
  });
  const sidecar: PostSidecar = {
    schema_version: SCHEMA_VERSION,
    post_id: 7,
    type: 'post',
    slug: 'hello',
    file_path: 'posts/hello.html',
    body_hash: bodyHash,
    last_scanned: '2026-01-01T00:00:00.000Z',
    links,
  };

  const storage = new FsPluginStorage(path.join(dir, '.cmsinsight', 'broken-links'));
  await saveSidecar(storage, sidecar);
  return { dir, storage, sidecar };
}

describe('broken-links applyAction', () => {
  it.each([
    { label: 'relative', newHref: '/fixed/path?ok=1&ref=two' },
    { label: 'absolute', newHref: 'https://example.org/fixed/path?ok=1&ref=two' },
  ])(
    'stores a $label replacement URL and preserves the rest of the anchor tag',
    async ({ newHref }) => {
      const { dir, storage, sidecar } = await setup();
      const ctx = createApplyContext({ contentDir: dir, storage });
      const link = sidecar.links[0]!;

      const result = await applyAction(ctx, {
        kind: 'edit',
        siteUrl: 'https://example.com/',
        stripParams: [],
        edits: [
          {
            postType: 'post',
            slug: 'hello',
            linkId: link.id,
            action: 'replace',
            newHref,
          },
        ],
      });

      expect(result.ok).toBe(true);
      const after = await fs.readFile(path.join(dir, 'posts', 'hello.html'), 'utf8');
      expect(after).toContain(
        `<a class="external" rel="nofollow ugc" target="_blank" data-foo="bar" href="${newHref.replace(/&/g, '&amp;')}">dead link</a>`,
      );
      expect(after).not.toContain('https://old.test/dead');

      const refreshed = await loadSidecar(storage, 'post', 'hello');
      expect(refreshed?.links).toHaveLength(1);
      expect(refreshed?.links[0]?.href).toBe(newHref);
      expect(refreshed?.links[0]?.action).toMatchObject({
        type: 'replace',
        new_href: newHref,
      });
    },
  );

  it('marks a kept link as applied without touching the file', async () => {
    const { dir, storage, sidecar } = await setup();
    const ctx = createApplyContext({ contentDir: dir, storage });
    const link = sidecar.links[0]!;
    const before = await fs.readFile(path.join(dir, 'posts', 'hello.html'), 'utf8');

    const result = await applyAction(ctx, {
      kind: 'edit',
      siteUrl: 'https://example.com/',
      stripParams: [],
      edits: [
        { postType: 'post', slug: 'hello', linkId: link.id, action: 'keep' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.changedFiles ?? []).toEqual([]);
    const after = await fs.readFile(path.join(dir, 'posts', 'hello.html'), 'utf8');
    expect(after).toBe(before);

    const refreshed = await loadSidecar(storage, 'post', 'hello');
    expect(refreshed?.links).toHaveLength(1);
    expect(refreshed?.links[0]?.action).toMatchObject({
      type: 'keep',
      new_href: null,
    });
    expect(refreshed?.links[0]?.action?.applied_at).toEqual(expect.any(String));
  });
});
