import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LoadEnvOptions {
  /** Per-site content directory. Highest-priority file slot. */
  contentDir?: string;
  /** Multi-site root directory. Loaded after per-site, before user-home. */
  root?: string;
}

export interface LoadEnvResult {
  /** Absolute paths of .env files that were found and applied. */
  loadedFrom: string[];
}

function parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*export\s+/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const inlineComment = value.search(/\s#/);
      if (inlineComment !== -1) value = value.slice(0, inlineComment).trim();
    }
    if (key) env[key] = value;
  }
  return env;
}

async function readEnvFile(p: string): Promise<Record<string, string> | undefined> {
  try {
    const text = await fs.readFile(p, 'utf8');
    return parseDotenv(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function applyEnv(parsed: Record<string, string>): void {
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

async function loadFromDir(dir: string, loadedFrom: string[]): Promise<void> {
  const p = path.join(dir, '.cmsinsight', '.env');
  const env = await readEnvFile(p);
  if (env) {
    applyEnv(env);
    loadedFrom.push(p);
  }
}

/**
 * Load environment variables from `.env` files. Priority (highest first):
 *   1. process.env (whatever was set before launch — never overwritten)
 *   2. `<contentDir>/.cmsinsight/.env` (per-site)
 *   3. `<root>/.cmsinsight/.env` (multi-site root, shared across sites)
 *   4. `~/.cmsinsight/.env` (user-wide)
 */
export async function loadEnvFiles(opts: LoadEnvOptions): Promise<LoadEnvResult> {
  const loadedFrom: string[] = [];
  if (opts.contentDir) await loadFromDir(opts.contentDir, loadedFrom);
  if (opts.root) await loadFromDir(opts.root, loadedFrom);
  await loadFromDir(os.homedir(), loadedFrom);
  return { loadedFrom };
}
