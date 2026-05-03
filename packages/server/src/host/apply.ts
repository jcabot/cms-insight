import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ApplyContext, PluginStorage } from '@cms-insight/plugin-api';
import { parseFile } from '../content/frontmatter.js';
import { hashBytes } from './hash.js';
import { atomicWrite } from './atomic-write.js';

export class StaleFileError extends Error {
  constructor(public readonly filePath: string) {
    super(`File ${filePath} changed since extraction; refusing to apply edit`);
    this.name = 'StaleFileError';
  }
}

function ensureWithinContent(contentDir: string, rel: string): string {
  if (path.isAbsolute(rel)) {
    throw new Error(`expected relative path, got absolute: ${rel}`);
  }
  const abs = path.resolve(contentDir, rel);
  const normContent = path.resolve(contentDir);
  if (!abs.startsWith(normContent + path.sep) && abs !== normContent) {
    throw new Error(`path escapes content directory: ${rel}`);
  }
  return abs;
}

export interface CreateApplyContextOptions {
  contentDir: string;
  storage: PluginStorage;
}

export function createApplyContext(opts: CreateApplyContextOptions): ApplyContext {
  return {
    contentDir: opts.contentDir,
    storage: opts.storage,
    async readFile(relativePath: string): Promise<Buffer> {
      const abs = ensureWithinContent(opts.contentDir, relativePath);
      return fs.readFile(abs);
    },
    async writeFile(
      relativePath: string,
      contents: Buffer,
      expectedHash: string,
    ): Promise<void> {
      const abs = ensureWithinContent(opts.contentDir, relativePath);
      const current = await fs.readFile(abs);
      const currentText = current.toString('utf8');
      const currentParsed = parseFile(currentText);
      const currentBodyHash = hashBytes(Buffer.from(currentParsed.body, 'utf8'));
      if (currentBodyHash !== expectedHash) {
        throw new StaleFileError(relativePath);
      }
      await atomicWrite(abs, contents);
    },
  };
}
