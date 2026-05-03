import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadPost, type ContentPost } from './post.js';

export interface ScanOptions {
  statuses?: ReadonlyArray<string>;
}

async function listHtml(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.html'))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function listPostFiles(contentDir: string): Promise<string[]> {
  const [posts, pages] = await Promise.all([
    listHtml(path.join(contentDir, 'posts')),
    listHtml(path.join(contentDir, 'pages')),
  ]);
  return [...posts, ...pages];
}

export async function* scanPosts(
  contentDir: string,
  options: ScanOptions = {},
): AsyncIterable<ContentPost> {
  const files = await listPostFiles(contentDir);
  const statuses = options.statuses;
  for (const f of files) {
    let post: ContentPost;
    try {
      post = await loadPost(f, contentDir);
    } catch (err) {
      console.warn(`[cms-insight] skipping unreadable file ${f}: ${(err as Error).message}`);
      continue;
    }
    if (statuses && !statuses.includes(post.status)) continue;
    yield post;
  }
}

export async function loadAllPosts(
  contentDir: string,
  options: ScanOptions = {},
): Promise<ContentPost[]> {
  const out: ContentPost[] = [];
  for await (const p of scanPosts(contentDir, options)) out.push(p);
  return out;
}
