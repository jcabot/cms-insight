import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApplyContext, StaleFileError } from './apply.js';
import { FsPluginStorage } from './plugin-storage.js';
import { hashBytes } from './hash.js';

const POST = `---
type: post
slug: hello
title: Hello
status: publish
date_gmt: '2026-01-01T00:00:00'
modified_gmt: '2026-01-01T00:00:00'
---

<p>hello <a href="https://x.test/">world</a></p>
`;

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cmsi-apply-'));
}

describe('AC4: apply stale-hash refusal', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir();
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.mkdir(path.join(dir, '.cmsinsight', 'broken-links'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts', 'hello.html'), POST, 'utf8');
  });

  it('rejects writeFile when on-disk body hash differs from expectedHash', async () => {
    const storage = new FsPluginStorage(path.join(dir, '.cmsinsight', 'broken-links'));
    const ctx = createApplyContext({ contentDir: dir, storage });
    const wrongHash = 'sha256:' + 'f'.repeat(64);
    await expect(
      ctx.writeFile('posts/hello.html', Buffer.from('garbage'), wrongHash),
    ).rejects.toBeInstanceOf(StaleFileError);
  });

  it('accepts writeFile when expectedHash matches', async () => {
    const storage = new FsPluginStorage(path.join(dir, '.cmsinsight', 'broken-links'));
    const ctx = createApplyContext({ contentDir: dir, storage });

    const buf = await ctx.readFile('posts/hello.html');
    const text = buf.toString('utf8');
    const bodyStart = text.indexOf('\n---\n') + '\n---\n'.length;
    const body = text.slice(bodyStart).replace(/^\r?\n/, '');
    const expected = hashBytes(Buffer.from(body, 'utf8'));

    const newText = text.replace('https://x.test/', 'https://y.test/');
    await ctx.writeFile('posts/hello.html', Buffer.from(newText, 'utf8'), expected);

    const after = await fs.readFile(path.join(dir, 'posts', 'hello.html'), 'utf8');
    expect(after).toContain('https://y.test/');
    expect(after).not.toContain('https://x.test/');
  });

  it('rejects writeFile after file is modified externally', async () => {
    const storage = new FsPluginStorage(path.join(dir, '.cmsinsight', 'broken-links'));
    const ctx = createApplyContext({ contentDir: dir, storage });

    const buf = await ctx.readFile('posts/hello.html');
    const text = buf.toString('utf8');
    const bodyStart = text.indexOf('\n---\n') + '\n---\n'.length;
    const body = text.slice(bodyStart).replace(/^\r?\n/, '');
    const expected = hashBytes(Buffer.from(body, 'utf8'));

    // External modification of the body
    await fs.writeFile(
      path.join(dir, 'posts', 'hello.html'),
      text.replace('<p>hello', '<p>HELLO'),
      'utf8',
    );

    const newText = text.replace('https://x.test/', 'https://y.test/');
    await expect(
      ctx.writeFile('posts/hello.html', Buffer.from(newText, 'utf8'), expected),
    ).rejects.toBeInstanceOf(StaleFileError);
  });
});
