import { promises as fs } from 'node:fs';
import path from 'node:path';
import TOML from '@iarna/toml';
import { CONFIG_DEFAULTS, DEFAULT_CONFIG_TOML, LLM_DEFAULTS, type CmsInsightConfig } from './defaults.js';

export interface LoadedConfig {
  contentDir: string;
  siteUrl: string;
  config: CmsInsightConfig;
}

interface WpsyncConfig {
  site_url?: string;
  content_dir?: string;
}

async function readTextOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function readToml<T>(p: string): Promise<T | undefined> {
  const text = await readTextOrUndefined(p);
  if (text === undefined) return undefined;
  return TOML.parse(text) as unknown as T;
}

async function ensureGitignoreEntry(contentDir: string): Promise<void> {
  const giPath = path.join(contentDir, '.gitignore');
  const entry = '.cmsinsight/';
  const existing = (await readTextOrUndefined(giPath)) ?? '';
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (
    lines.includes(entry) ||
    lines.includes('.cmsinsight') ||
    lines.includes('/.cmsinsight/')
  ) {
    return;
  }
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fs.writeFile(giPath, `${existing}${sep}${entry}\n`, 'utf8');
}

export async function loadConfig(contentDir: string): Promise<LoadedConfig> {
  const absDir = path.resolve(contentDir);
  try {
    await fs.access(absDir);
  } catch {
    throw new Error(`Content directory not found: ${absDir}`);
  }

  const wpsyncCfgPath = path.join(absDir, '.wpsync', 'config.toml');
  const wpsync = await readToml<WpsyncConfig>(wpsyncCfgPath);
  if (!wpsync || typeof wpsync.site_url !== 'string') {
    throw new Error(
      `Missing or invalid .wpsync/config.toml at ${wpsyncCfgPath} (expected key 'site_url').`,
    );
  }
  const siteUrl = wpsync.site_url;

  const cmsiDir = path.join(absDir, '.cmsinsight');
  const cmsiCfgPath = path.join(cmsiDir, 'config.toml');
  await fs.mkdir(cmsiDir, { recursive: true });

  let userCfg = await readToml<Partial<CmsInsightConfig>>(cmsiCfgPath);
  if (userCfg === undefined) {
    await fs.writeFile(cmsiCfgPath, DEFAULT_CONFIG_TOML, 'utf8');
    await ensureGitignoreEntry(absDir);
    userCfg = {};
  }

  const merged: CmsInsightConfig = {
    ...CONFIG_DEFAULTS,
    ...userCfg,
    llm: { ...LLM_DEFAULTS, ...(userCfg.llm ?? {}) },
  };
  return { contentDir: absDir, siteUrl, config: merged };
}

function mergePlugins(
  ...sources: ReadonlyArray<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const src of sources) {
    if (!src) continue;
    any = true;
    for (const [k, v] of Object.entries(src)) {
      const prev = out[k];
      out[k] =
        prev && typeof prev === 'object' && v && typeof v === 'object'
          ? { ...(prev as Record<string, unknown>), ...(v as Record<string, unknown>) }
          : v;
    }
  }
  return any ? out : undefined;
}

export async function writeConfig(
  contentDir: string,
  patch: Partial<CmsInsightConfig>,
): Promise<CmsInsightConfig> {
  const absDir = path.resolve(contentDir);
  const cmsiCfgPath = path.join(absDir, '.cmsinsight', 'config.toml');
  const existing = (await readToml<Partial<CmsInsightConfig>>(cmsiCfgPath)) ?? {};
  const merged: CmsInsightConfig = {
    ...CONFIG_DEFAULTS,
    ...existing,
    ...patch,
    llm: { ...LLM_DEFAULTS, ...(existing.llm ?? {}), ...(patch.llm ?? {}) },
    plugins: mergePlugins(existing.plugins, patch.plugins),
  };
  if (merged.plugins === undefined) delete (merged as { plugins?: unknown }).plugins;
  const out = TOML.stringify(merged as unknown as TOML.JsonMap);
  await fs.writeFile(cmsiCfgPath, out, 'utf8');
  return merged;
}
