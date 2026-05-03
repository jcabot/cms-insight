import YAML from 'yaml';
import type { PostType } from '@cms-insight/plugin-api';

export interface FrontMatter {
  id?: number;
  type: PostType;
  slug: string;
  title: string;
  status: string;
  parent?: number;
  categories?: string[];
  tags?: string[];
  featured_media?: number;
  excerpt?: string;
  date_gmt?: string;
  modified_gmt?: string;
  [key: string]: unknown;
}

export interface ParsedFile {
  frontMatter: FrontMatter;
  body: string;
  bodyByteOffset: number;
}

const FENCE = '---\n';

export function parseFile(text: string): ParsedFile {
  if (!text.startsWith(FENCE) && !text.startsWith('---\r\n')) {
    throw new Error('File does not start with --- front-matter fence');
  }
  const fenceLen = text.startsWith(FENCE) ? FENCE.length : '---\r\n'.length;
  const closeRegex = /\r?\n---\r?\n/;
  const rest = text.slice(fenceLen);
  const m = rest.match(closeRegex);
  if (!m || m.index === undefined) {
    throw new Error('Front-matter closing --- not found');
  }
  const yamlText = rest.slice(0, m.index);
  const closeStart = fenceLen + m.index;
  const closeEnd = closeStart + m[0].length;
  let body = text.slice(closeEnd);
  if (body.startsWith('\n') || body.startsWith('\r\n')) {
    body = body.replace(/^\r?\n/, '');
  }
  const bodyOffsetInString = text.length - body.length;
  const fm = (YAML.parse(yamlText) ?? {}) as FrontMatter;
  if (!fm.type || !fm.slug || !fm.title || !fm.status) {
    throw new Error('Front-matter missing required keys (type, slug, title, status)');
  }
  return { frontMatter: fm, body, bodyByteOffset: bodyOffsetInString };
}
