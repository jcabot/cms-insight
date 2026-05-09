import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicWrite } from '../host/atomic-write.js';
import { loadConfig } from '../config/load.js';
import type { LastAnalysis, SiteEntry, SiteRegistryFile } from './types.js';

const REGISTRY_VERSION = 1 as const;

function registryPath(root: string): string {
  return path.join(root, '.cmsinsight', 'sites.json');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateId(relPath: string, taken: ReadonlySet<string>): string {
  const base = slugify(relPath) || 'site';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}-${i}`;
    if (!taken.has(cand)) return cand;
  }
  throw new Error(`could not generate unique site id from ${relPath}`);
}

function ensureInsideRoot(root: string, candidateRel: string): string {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, candidateRel);
  const rel = path.relative(rootAbs, targetAbs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path is not inside root: ${candidateRel}`);
  }
  // Normalize to forward-slash form for cross-platform stability in the JSON file.
  return rel.split(path.sep).join('/');
}

export interface SiteRegistryService {
  readonly root: string;
  list(): readonly SiteEntry[];
  get(id: string): SiteEntry | undefined;
  activeId(): string | undefined;
  active(): SiteEntry | undefined;
  contentDirFor(id: string): string;
  addSite(input: { relPath: string; label?: string }): Promise<SiteEntry>;
  removeSite(id: string): Promise<void>;
  reorder(orderedIds: readonly string[]): Promise<void>;
  rename(id: string, label: string): Promise<void>;
  setActive(id: string): Promise<void>;
  updateLastAnalysis(siteId: string, pluginId: string, summary: LastAnalysis): Promise<void>;
  refreshPostCount(siteId: string, count: number): Promise<void>;
}

async function readRegistry(root: string): Promise<SiteRegistryFile> {
  const file = registryPath(root);
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text) as Partial<SiteRegistryFile>;
    return {
      version: REGISTRY_VERSION,
      sites: Array.isArray(parsed.sites) ? (parsed.sites as SiteEntry[]) : [],
      activeSiteId: typeof parsed.activeSiteId === 'string' ? parsed.activeSiteId : undefined,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: REGISTRY_VERSION, sites: [], activeSiteId: undefined };
    }
    throw err;
  }
}

async function writeRegistry(root: string, reg: SiteRegistryFile): Promise<void> {
  const file = registryPath(root);
  const payload = Buffer.from(JSON.stringify(reg, null, 2) + '\n', 'utf8');
  await atomicWrite(file, payload);
}

export async function loadOrCreateRegistry(root: string): Promise<SiteRegistryService> {
  const rootAbs = path.resolve(root);
  try {
    await fs.access(rootAbs);
  } catch {
    throw new Error(`Root directory not found: ${rootAbs}`);
  }
  const initial = await readRegistry(rootAbs);
  // Persist the freshly-created file so AC1 holds even if no mutations follow.
  if (!(await fileExists(registryPath(rootAbs)))) {
    await writeRegistry(rootAbs, initial);
  }

  let state: SiteRegistryFile = initial;

  function commit(next: SiteRegistryFile): Promise<void> {
    state = next;
    return writeRegistry(rootAbs, next);
  }

  async function validateSitePath(relPath: string): Promise<string> {
    const normalizedRel = ensureInsideRoot(rootAbs, relPath);
    const absDir = path.join(rootAbs, normalizedRel);
    // loadConfig requires .wpsync/config.toml with site_url. It also creates
    // .cmsinsight/config.toml lazily, which is desirable here.
    await loadConfig(absDir);
    return normalizedRel;
  }

  const service: SiteRegistryService = {
    get root() {
      return rootAbs;
    },
    list: () => state.sites,
    get: (id: string) => state.sites.find((s) => s.id === id),
    activeId: () => state.activeSiteId,
    active: () =>
      state.activeSiteId ? state.sites.find((s) => s.id === state.activeSiteId) : undefined,
    contentDirFor(id: string): string {
      const site = state.sites.find((s) => s.id === id);
      if (!site) throw new Error(`unknown site: ${id}`);
      return path.join(rootAbs, site.relPath);
    },

    async addSite({ relPath, label }) {
      const normalizedRel = await validateSitePath(relPath);
      const dup = state.sites.find((s) => s.relPath === normalizedRel);
      if (dup) throw new Error(`site already registered: ${normalizedRel}`);
      const taken = new Set(state.sites.map((s) => s.id));
      const id = generateId(normalizedRel, taken);
      const entry: SiteEntry = {
        id,
        label: label?.trim() || path.basename(normalizedRel),
        relPath: normalizedRel,
        addedAt: new Date().toISOString(),
      };
      const sites = [...state.sites, entry];
      const activeSiteId = state.activeSiteId ?? id;
      await commit({ ...state, sites, activeSiteId });
      return entry;
    },

    async removeSite(id) {
      const idx = state.sites.findIndex((s) => s.id === id);
      if (idx === -1) throw new Error(`unknown site: ${id}`);
      const sites = state.sites.filter((s) => s.id !== id);
      let activeSiteId = state.activeSiteId;
      if (activeSiteId === id) activeSiteId = sites[0]?.id;
      await commit({ ...state, sites, activeSiteId });
    },

    async reorder(orderedIds) {
      const idSet = new Set(state.sites.map((s) => s.id));
      const seen = new Set<string>();
      for (const id of orderedIds) {
        if (!idSet.has(id)) throw new Error(`unknown site in order: ${id}`);
        if (seen.has(id)) throw new Error(`duplicate site in order: ${id}`);
        seen.add(id);
      }
      if (seen.size !== state.sites.length) {
        throw new Error(`reorder must include every site exactly once`);
      }
      const byId = new Map(state.sites.map((s) => [s.id, s]));
      const sites = orderedIds.map((id) => byId.get(id)!);
      await commit({ ...state, sites });
    },

    async rename(id, label) {
      const trimmed = label.trim();
      if (!trimmed) throw new Error(`label cannot be empty`);
      const sites = state.sites.map((s) => (s.id === id ? { ...s, label: trimmed } : s));
      if (!sites.some((s) => s.id === id)) throw new Error(`unknown site: ${id}`);
      await commit({ ...state, sites });
    },

    async setActive(id) {
      if (!state.sites.some((s) => s.id === id)) throw new Error(`unknown site: ${id}`);
      await commit({ ...state, activeSiteId: id });
    },

    async updateLastAnalysis(siteId, pluginId, summary) {
      const sites = state.sites.map((s) => {
        if (s.id !== siteId) return s;
        const lastAnalyses = { ...(s.lastAnalyses ?? {}), [pluginId]: summary };
        return { ...s, lastAnalyses };
      });
      if (!sites.some((s) => s.id === siteId)) return;
      await commit({ ...state, sites });
    },

    async refreshPostCount(siteId, count) {
      const sites = state.sites.map((s) => (s.id === siteId ? { ...s, postCount: count } : s));
      if (!sites.some((s) => s.id === siteId)) return;
      await commit({ ...state, sites });
    },
  };

  return service;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
