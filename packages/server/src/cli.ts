#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import openModule from 'open';
import { promises as fs } from 'node:fs';
import { CONFIG_DEFAULTS } from './config/defaults.js';
import { loadConfig } from './config/load.js';
import { buildServer } from './http/server.js';
import { loadEnvFiles } from './dotenv.js';
import { loadState, saveState, STATE_FILE_PATH } from './state.js';
import { createAppContext } from './app-context.js';
import { loadOrCreateRegistry } from './sites/registry.js';

const program = new Command();
program
  .name('cms-insight')
  .description('Local dashboard for wpsync-managed content (multi-site)')
  .version('0.2.0');

program
  .command('start')
  .description('Start the dashboard server against a multi-site root')
  .option(
    '-r, --root <path>',
    'multi-site root directory (parent of one or more wpsync content dirs); defaults to last-used or cwd',
  )
  .option('-p, --port <number>', 'port to bind (overrides config)')
  .option('--no-open', 'do not auto-open the browser')
  .action(async (opts: { root?: string; port?: string; open: boolean }) => {
    const stored = await loadState();
    const fallback = process.cwd();
    const initialRoot = path.resolve(opts.root ?? stored?.lastRootPath ?? fallback);

    try {
      await fs.access(initialRoot);
    } catch (err) {
      const fromState = !opts.root && stored?.lastRootPath && initialRoot !== fallback;
      if (fromState) {
        console.warn(
          `[cms-insight] last-used root ${stored?.lastRootPath} is unavailable: ${(err as Error).message}`,
        );
        await fs.unlink(STATE_FILE_PATH).catch(() => {});
        throw new Error(
          `cms-insight could not find the configured root directory.\n` +
            `Run with --root <path> pointing at a directory whose subfolders are wpsync content dirs.`,
        );
      }
      throw err;
    }

    const registry = await loadOrCreateRegistry(initialRoot);

    // Pick initial active site: registry's saved choice → state's saved choice → first site → none.
    const candidates = [
      registry.activeId(),
      stored?.lastActiveSiteId,
      registry.list()[0]?.id,
    ];
    let initialActiveId: string | undefined;
    for (const c of candidates) {
      if (c && registry.get(c)) {
        initialActiveId = c;
        break;
      }
    }

    // Eagerly load root + home env so the LLM key is available even before a site is active.
    await loadEnvFiles({ root: initialRoot });

    // Choose a port: override > active site's config > root-level default.
    let port: number = CONFIG_DEFAULTS.port;
    if (initialActiveId) {
      try {
        const loaded = await loadConfig(path.join(initialRoot, registry.get(initialActiveId)!.relPath));
        port = loaded.config.port;
      } catch {
        /* fall through to default */
      }
    }
    if (opts.port) port = Number(opts.port);

    await saveState({ lastRootPath: initialRoot, lastActiveSiteId: initialActiveId });

    const ctx = await createAppContext({
      root: initialRoot,
      registry,
      onActiveChanged: async (siteId) => {
        await saveState({ lastRootPath: initialRoot, lastActiveSiteId: siteId });
      },
    });

    if (initialActiveId) {
      try {
        await ctx.setActiveSite(initialActiveId);
        console.log(
          `[cms-insight] root: ${initialRoot} · active: ${ctx.activeSiteId} (${ctx.contentDir})`,
        );
        if (ctx.runner.llmEnabled) {
          console.log(`[cms-insight] LLM features enabled`);
        } else if (ctx.llmDisabledReason) {
          console.warn(`[cms-insight] LLM features disabled: ${ctx.llmDisabledReason}`);
        }
      } catch (err) {
        console.warn(
          `[cms-insight] could not activate site "${initialActiveId}": ${(err as Error).message}`,
        );
      }
    } else {
      console.log(
        `[cms-insight] root: ${initialRoot} · no sites yet — open the dashboard and add one`,
      );
    }

    const app = await buildServer(ctx);

    await app.listen({ host: '127.0.0.1', port });
    const url = `http://127.0.0.1:${port}`;
    app.log.info({ url, root: ctx.root, activeSiteId: ctx.activeSiteId }, 'cms-insight ready');

    const shouldOpen = opts.open && (ctx.config.open_browser ?? true);
    if (shouldOpen) {
      try {
        await openModule(url);
      } catch (err) {
        app.log.warn({ err }, 'failed to open browser');
      }
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
