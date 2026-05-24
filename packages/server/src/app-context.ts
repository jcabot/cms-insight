import path from 'node:path';
import { CONFIG_DEFAULTS, type CmsInsightConfig } from './config/defaults.js';
import { loadConfig } from './config/load.js';
import { createPluginRunner, type PluginRunner } from './plugins/runner.js';
import { createLlmProvider } from './llm/factory.js';
import { loadEnvFiles } from './dotenv.js';
import { loadOrCreateRegistry, type SiteRegistryService } from './sites/registry.js';

export interface AppContext {
  /** Absolute path to the multi-site root. */
  root: string;
  /** Site registry service. Source of truth for sites + active selection. */
  registry: SiteRegistryService;
  /** Active site id (mirror of registry.activeId(), refreshed on setActiveSite). */
  activeSiteId: string | undefined;
  /** Active site's content dir. Empty string when no site is active. */
  contentDir: string;
  /** Active site's site_url. Empty string when no site is active. */
  siteUrl: string;
  /** Active site's merged config; defaults when no site is active. */
  config: CmsInsightConfig;
  /** Plugin runner against the active site. Noop runner when no site is active. */
  runner: PluginRunner;
  /** Set when the LLM provider could not be constructed (e.g. missing API key). */
  llmDisabledReason: string | undefined;
  /** Switch the active site. Pass undefined to clear active. Persists to registry + state. */
  setActiveSite(siteId: string | undefined): Promise<void>;
  /** Swap the multi-site root: load that root's registry, then activate its saved/first site. */
  setRoot(newRoot: string): Promise<void>;
  /** Refresh `runner.config` etc. after a config write that didn't change site. */
  refreshConfig(updated: CmsInsightConfig): void;
}

function noopRunner(): PluginRunner {
  return {
    contentDir: '',
    siteUrl: '',
    config: CONFIG_DEFAULTS,
    llmEnabled: false,
    list: () => [],
    get: () => undefined,
    startRun: async () => {
      throw new Error('no active site');
    },
    cancelRun: () => false,
    getRun: () => undefined,
    subscribe: (_id, cb) => {
      cb({ kind: 'closed', status: 'finished' });
      return () => {};
    },
    listActions: () => [],
    startAction: async () => {
      throw new Error('no active site');
    },
    cancelAction: () => false,
    getAction: () => undefined,
    subscribeAction: (_pid, _aid, cb) => {
      cb({ kind: 'closed', status: 'finished' });
      return () => {};
    },
  };
}

export interface CreateAppContextOptions {
  root: string;
  registry: SiteRegistryService;
  /**
   * Persist the chosen root + active site id (e.g. into ~/.cmsinsight/state.json).
   * `root` is passed explicitly because it can change at runtime via `setRoot`.
   */
  onActiveChanged?: (siteId: string | undefined, root: string) => Promise<void>;
}

export async function createAppContext(opts: CreateAppContextOptions): Promise<AppContext> {
  const ctx: AppContext = {
    root: opts.root,
    registry: opts.registry,
    activeSiteId: undefined,
    contentDir: '',
    siteUrl: '',
    config: CONFIG_DEFAULTS,
    runner: noopRunner(),
    llmDisabledReason: undefined,
    async setActiveSite(siteId: string | undefined): Promise<void> {
      if (siteId === undefined) {
        for (const p of ctx.runner.list()) ctx.runner.cancelRun(p.plugin.id);
        ctx.activeSiteId = undefined;
        ctx.contentDir = '';
        ctx.siteUrl = '';
        ctx.config = CONFIG_DEFAULTS;
        ctx.runner = noopRunner();
        ctx.llmDisabledReason = undefined;
        if (opts.onActiveChanged) await opts.onActiveChanged(undefined, ctx.root);
        return;
      }

      const site = ctx.registry.get(siteId);
      if (!site) throw new Error(`unknown site: ${siteId}`);
      const contentDir = path.join(ctx.root, site.relPath);
      const loaded = await loadConfig(contentDir);

      // Cancel any in-flight jobs on the previous runner before swapping it out.
      for (const p of ctx.runner.list()) ctx.runner.cancelRun(p.plugin.id);

      await loadEnvFiles({ contentDir: loaded.contentDir, root: ctx.root });
      const llmInit = createLlmProvider(loaded.config.llm);
      const nextRunner = await createPluginRunner({
        contentDir: loaded.contentDir,
        siteUrl: loaded.siteUrl,
        config: loaded.config,
        llm: llmInit.provider,
        onJobFinished: (info) => {
          // Only the primary `run` flow contributes to the home dashboard's headline.
          if (info.actionName !== 'primary') return;
          if (info.status !== 'finished') return;
          // Run async work in the background; failures shouldn't bubble to the runner.
          void (async () => {
            try {
              const headline =
                (await info.plugin.formatHeadline?.(info.storage)) ?? info.summary ?? 'completed';
              if (ctx.activeSiteId) {
                await ctx.registry.updateLastAnalysis(ctx.activeSiteId, info.pluginId, {
                  finishedAt: info.finishedAt,
                  headline,
                });
              }
            } catch (err) {
              console.warn(
                `[cms-insight] failed to update lastAnalyses for ${info.pluginId}: ${(err as Error).message}`,
              );
            }
          })();
        },
      });

      ctx.activeSiteId = siteId;
      ctx.contentDir = loaded.contentDir;
      ctx.siteUrl = loaded.siteUrl;
      ctx.config = loaded.config;
      ctx.runner = nextRunner;
      ctx.llmDisabledReason = llmInit.disabledReason;

      if (ctx.registry.activeId() !== siteId) {
        await ctx.registry.setActive(siteId);
      }
      if (opts.onActiveChanged) await opts.onActiveChanged(siteId, ctx.root);
    },
    async setRoot(newRoot: string): Promise<void> {
      // Throws if the directory is missing; do this before tearing down current state.
      const registry = await loadOrCreateRegistry(newRoot);
      // Cancel any in-flight jobs on the current runner before swapping roots.
      for (const p of ctx.runner.list()) ctx.runner.cancelRun(p.plugin.id);
      ctx.root = registry.root;
      ctx.registry = registry;
      // Activate the new root's saved choice, else its first site, else clear.
      const nextId = registry.activeId() ?? registry.list()[0]?.id;
      await ctx.setActiveSite(nextId);
    },
    refreshConfig(updated: CmsInsightConfig): void {
      Object.assign(ctx.config, updated);
      ctx.runner.config = updated;
    },
  };
  return ctx;
}
