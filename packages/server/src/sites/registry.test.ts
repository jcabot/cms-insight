import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateRegistry } from './registry.js';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cmsi-sites-'));
}

async function makeSite(root: string, rel: string, siteUrl: string): Promise<void> {
  const dir = path.join(root, rel);
  await fs.mkdir(path.join(dir, '.wpsync'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.wpsync', 'config.toml'),
    `site_url = "${siteUrl}"\n`,
    'utf8',
  );
}

describe('site registry', () => {
  let root: string;
  beforeEach(async () => {
    root = await tmpRoot();
  });

  it('creates sites.json on first load even when empty', async () => {
    const reg = await loadOrCreateRegistry(root);
    expect(reg.list()).toEqual([]);
    expect(reg.activeId()).toBeUndefined();
    const onDisk = JSON.parse(
      await fs.readFile(path.join(root, '.cmsinsight', 'sites.json'), 'utf8'),
    );
    expect(onDisk).toMatchObject({ version: 1, sites: [] });
  });

  it('rejects paths outside the root', async () => {
    const reg = await loadOrCreateRegistry(root);
    await expect(reg.addSite({ relPath: '../escape' })).rejects.toThrow(/inside root/);
  });

  it('rejects subfolders without .wpsync/config.toml', async () => {
    await fs.mkdir(path.join(root, 'plain'), { recursive: true });
    const reg = await loadOrCreateRegistry(root);
    await expect(reg.addSite({ relPath: 'plain' })).rejects.toThrow();
  });

  it('adds sites with auto-generated ids and labels', async () => {
    await makeSite(root, 'blog-en', 'https://en.example.com');
    await makeSite(root, 'blog-fr', 'https://fr.example.com');
    const reg = await loadOrCreateRegistry(root);
    const a = await reg.addSite({ relPath: 'blog-en' });
    const b = await reg.addSite({ relPath: 'blog-fr', label: 'Le Blog' });
    expect(a.id).toBe('blog-en');
    expect(a.label).toBe('blog-en');
    expect(b.label).toBe('Le Blog');
    expect(reg.list().map((s) => s.id)).toEqual(['blog-en', 'blog-fr']);
    // First add becomes the active site automatically.
    expect(reg.activeId()).toBe('blog-en');
  });

  it('rejects duplicate relPath', async () => {
    await makeSite(root, 'a', 'https://a.example.com');
    const reg = await loadOrCreateRegistry(root);
    await reg.addSite({ relPath: 'a' });
    await expect(reg.addSite({ relPath: 'a' })).rejects.toThrow(/already registered/);
  });

  it('reorders, renames, and persists across reload', async () => {
    await makeSite(root, 'a', 'https://a.example.com');
    await makeSite(root, 'b', 'https://b.example.com');
    await makeSite(root, 'c', 'https://c.example.com');

    const reg = await loadOrCreateRegistry(root);
    await reg.addSite({ relPath: 'a' });
    await reg.addSite({ relPath: 'b' });
    await reg.addSite({ relPath: 'c' });

    await reg.reorder(['c', 'a', 'b']);
    await reg.rename('b', 'B-renamed');
    await reg.setActive('c');

    const reg2 = await loadOrCreateRegistry(root);
    expect(reg2.list().map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(reg2.get('b')?.label).toBe('B-renamed');
    expect(reg2.activeId()).toBe('c');
  });

  it('removes a site without touching its on-disk .cmsinsight folder', async () => {
    await makeSite(root, 'a', 'https://a.example.com');
    const reg = await loadOrCreateRegistry(root);
    await reg.addSite({ relPath: 'a' });
    // loadConfig creates <site>/.cmsinsight/ as a side-effect; verify it.
    const cmsiDir = path.join(root, 'a', '.cmsinsight');
    await fs.access(cmsiDir);

    await reg.removeSite('a');
    expect(reg.list()).toEqual([]);
    expect(reg.activeId()).toBeUndefined();
    // The site's on-disk state must be preserved (FR4).
    await fs.access(cmsiDir);
  });

  it('reorder rejects mismatched ids', async () => {
    await makeSite(root, 'a', 'https://a.example.com');
    await makeSite(root, 'b', 'https://b.example.com');
    const reg = await loadOrCreateRegistry(root);
    await reg.addSite({ relPath: 'a' });
    await reg.addSite({ relPath: 'b' });
    await expect(reg.reorder(['a'])).rejects.toThrow(/exactly once/);
    await expect(reg.reorder(['a', 'a'])).rejects.toThrow(/duplicate/);
    await expect(reg.reorder(['a', 'zz'])).rejects.toThrow(/unknown/);
  });

  it('updateLastAnalysis and refreshPostCount round-trip', async () => {
    await makeSite(root, 'a', 'https://a.example.com');
    const reg = await loadOrCreateRegistry(root);
    await reg.addSite({ relPath: 'a' });
    await reg.updateLastAnalysis('a', 'broken-links', {
      finishedAt: '2026-05-09T10:00:00Z',
      headline: '23 broken / 412 checked',
    });
    await reg.refreshPostCount('a', 412);

    const reg2 = await loadOrCreateRegistry(root);
    expect(reg2.get('a')?.postCount).toBe(412);
    expect(reg2.get('a')?.lastAnalyses?.['broken-links']).toEqual({
      finishedAt: '2026-05-09T10:00:00Z',
      headline: '23 broken / 412 checked',
    });
  });

  it('clears activeSiteId when active is removed and falls back to first remaining', async () => {
    await makeSite(root, 'a', 'https://a.example.com');
    await makeSite(root, 'b', 'https://b.example.com');
    const reg = await loadOrCreateRegistry(root);
    await reg.addSite({ relPath: 'a' });
    await reg.addSite({ relPath: 'b' });
    await reg.setActive('b');
    await reg.removeSite('b');
    expect(reg.activeId()).toBe('a');
  });
});
