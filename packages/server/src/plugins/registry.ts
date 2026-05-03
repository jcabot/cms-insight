import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AnalysisPlugin, ApplyContext, PluginManifest } from '@cms-insight/plugin-api';
import { FsPluginStorage } from '../host/plugin-storage.js';
import { createApplyContext } from '../host/apply.js';
import brokenLinksPlugin from './broken-links/index.js';

export interface RegisteredPlugin {
  plugin: AnalysisPlugin;
  storage: FsPluginStorage;
  manifest: PluginManifest;
  applyCtx: ApplyContext;
}

export interface RegistryOptions {
  contentDir: string;
}

async function readDirOrEmpty(p: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(p, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function registerPlugin(
  contentDir: string,
  plugin: AnalysisPlugin,
  manifest: PluginManifest,
): Promise<RegisteredPlugin> {
  const storage = new FsPluginStorage(path.join(contentDir, '.cmsinsight', plugin.id));
  await fs.mkdir(storage.rootDir, { recursive: true });
  return {
    plugin,
    storage,
    manifest,
    applyCtx: createApplyContext({ contentDir, storage }),
  };
}

export async function discoverPlugins(opts: RegistryOptions): Promise<RegisteredPlugin[]> {
  const out: RegisteredPlugin[] = [];

  out.push(
    await registerPlugin(opts.contentDir, brokenLinksPlugin, {
      id: 'broken-links',
      version: brokenLinksPlugin.version,
      apiVersion: '^1.0',
    }),
  );

  const localPluginsDir = path.join(opts.contentDir, '.cmsinsight', 'plugins');
  for (const e of await readDirOrEmpty(localPluginsDir)) {
    if (!e.isDirectory()) continue;
    const pluginDir = path.join(localPluginsDir, e.name);
    try {
      const manifest = await readJson<PluginManifest>(path.join(pluginDir, 'plugin.json'));
      if (!manifest) continue;
      const entry = path.join(pluginDir, 'index.js');
      const mod = (await import(entry)) as { default?: AnalysisPlugin };
      if (!mod.default) continue;
      out.push(await registerPlugin(opts.contentDir, mod.default, manifest));
    } catch (err) {
      console.warn(
        `[cms-insight] failed to load local plugin ${e.name}: ${(err as Error).message}`,
      );
    }
  }

  return out;
}
