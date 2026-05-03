import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ParsedPost } from '@cms-insight/plugin-api';
import { parseFile, type FrontMatter } from './frontmatter.js';
import { hashBytes } from '../host/hash.js';

export interface ContentPost extends ParsedPost {
  readonly frontMatter: FrontMatter;
  readonly absPath: string;
}

export async function loadPost(absPath: string, contentDir: string): Promise<ContentPost> {
  const buf = await fs.readFile(absPath);
  const text = buf.toString('utf8');
  const parsed = parseFile(text);
  const hash = hashBytes(parsed.body);
  const fm = parsed.frontMatter;

  const slug = fm.slug ?? path.basename(absPath, '.html');
  const rel = path.relative(contentDir, absPath).split(path.sep).join('/');

  let cachedBody: string | undefined = parsed.body;
  return {
    id: typeof fm.id === 'number' ? fm.id : undefined,
    type: fm.type,
    slug,
    title: fm.title,
    status: fm.status,
    filePath: rel,
    bodyHash: hash,
    body: async () => {
      if (cachedBody !== undefined) return cachedBody;
      const b = await fs.readFile(absPath, 'utf8');
      const p = parseFile(b);
      cachedBody = p.body;
      return cachedBody;
    },
    frontMatter: fm,
    absPath,
  };
}

export { hashBytes as hashBody } from '../host/hash.js';
