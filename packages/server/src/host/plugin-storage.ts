import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PluginStorage } from '@cms-insight/plugin-api';
import { atomicWrite } from './atomic-write.js';

function validateKey(key: string): void {
  if (key.length === 0) throw new Error('storage key must not be empty');
  if (path.isAbsolute(key)) throw new Error(`storage key must be relative: ${key}`);
  const parts = key.split(/[\\/]/);
  for (const part of parts) {
    if (part === '..' || part === '') {
      throw new Error(`invalid storage key: ${key}`);
    }
  }
}

async function* walkKeys(dir: string, root: string): AsyncIterable<string> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkKeys(abs, root);
    } else if (e.isFile()) {
      yield path.relative(root, abs).split(path.sep).join('/');
    }
  }
}

export class FsPluginStorage implements PluginStorage {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private resolve(key: string): string {
    validateKey(key);
    return path.join(this.rootDir, key);
  }

  async read<T = unknown>(key: string): Promise<T | undefined> {
    try {
      const text = await fs.readFile(this.resolve(key), 'utf8');
      return JSON.parse(text) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    const target = this.resolve(key);
    await atomicWrite(target, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async *list(prefix?: string): AsyncIterable<string> {
    const base = prefix ? this.resolve(prefix) : this.rootDir;
    yield* walkKeys(base, this.rootDir);
  }
}
