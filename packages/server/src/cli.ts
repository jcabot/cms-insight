#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import openModule from 'open';
import { promises as fs } from 'node:fs';
import { loadConfig, type LoadedConfig } from './config/load.js';
import { buildServer } from './http/server.js';
import { createPluginRunner } from './plugins/runner.js';
import { createLlmProvider } from './llm/factory.js';
import { loadEnvFiles } from './dotenv.js';
import { loadState, saveState, STATE_FILE_PATH } from './state.js';
import type { AppContext } from './app-context.js';

const program = new Command();
program
  .name('cms-insight')
  .description('Local dashboard for wpsync-managed content')
  .version('0.1.0');

program
  .command('start')
  .description('Start the dashboard server')
  .option(
    '-d, --dir <path>',
    'wpsync content directory (defaults to last-used dir or cwd)',
  )
  .option('-p, --port <number>', 'port to bind (overrides config)')
  .option('--no-open', 'do not auto-open the browser')
  .action(async (opts: { dir?: string; port?: string; open: boolean }) => {
    const stored = await loadState();
    const fallback = process.cwd();
    const initialDir = path.resolve(opts.dir ?? stored?.lastContentDir ?? fallback);

    let loaded: LoadedConfig;
    try {
      loaded = await loadConfig(initialDir);
    } catch (err) {
      const fromState = !opts.dir && stored?.lastContentDir && initialDir !== fallback;
      if (fromState) {
        console.warn(
          `[cms-insight] last-used directory ${stored?.lastContentDir} is unavailable: ${(err as Error).message}`,
        );
        try {
          console.warn(`[cms-insight] falling back to ${fallback}`);
          loaded = await loadConfig(fallback);
        } catch (fbErr) {
          await fs.unlink(STATE_FILE_PATH).catch(() => {});
          throw new Error(
            `cms-insight could not find a wpsync content directory.\n` +
              `  saved:    ${stored?.lastContentDir} — ${(err as Error).message}\n` +
              `  fallback: ${fallback} — ${(fbErr as Error).message}\n` +
              `Run with --dir <path> pointing at a directory that contains .wpsync/config.toml.`,
          );
        }
      } else {
        throw err;
      }
    }

    await saveState({ lastContentDir: loaded.contentDir });

    const port = opts.port ? Number(opts.port) : loaded.config.port;

    const envResult = await loadEnvFiles({ contentDir: loaded.contentDir });
    if (envResult.loadedFrom.length > 0) {
      console.log(`[cms-insight] loaded env from: ${envResult.loadedFrom.join(', ')}`);
    }

    const llmInit = createLlmProvider(loaded.config.llm);
    if (llmInit.disabledReason) {
      console.warn(`[cms-insight] LLM features disabled: ${llmInit.disabledReason}`);
    } else if (llmInit.provider) {
      console.log(
        `[cms-insight] LLM features enabled (${llmInit.provider.name} · ${llmInit.provider.model})`,
      );
    }

    const runner = await createPluginRunner({
      contentDir: loaded.contentDir,
      siteUrl: loaded.siteUrl,
      config: loaded.config,
      llm: llmInit.provider,
    });

    const ctx: AppContext = {
      contentDir: loaded.contentDir,
      siteUrl: loaded.siteUrl,
      config: loaded.config,
      runner,
      llmDisabledReason: llmInit.disabledReason,
      async reload(newDir: string): Promise<void> {
        const abs = path.resolve(newDir);
        const next = await loadConfig(abs);
        for (const p of ctx.runner.list()) {
          ctx.runner.cancelRun(p.plugin.id);
        }
        await loadEnvFiles({ contentDir: next.contentDir });
        const nextLlm = createLlmProvider(next.config.llm);
        const nextRunner = await createPluginRunner({
          contentDir: next.contentDir,
          siteUrl: next.siteUrl,
          config: next.config,
          llm: nextLlm.provider,
        });
        ctx.contentDir = next.contentDir;
        ctx.siteUrl = next.siteUrl;
        Object.assign(ctx.config, next.config);
        ctx.runner = nextRunner;
        ctx.llmDisabledReason = nextLlm.disabledReason;
        await saveState({ lastContentDir: ctx.contentDir });
      },
    };

    const app = await buildServer(ctx);

    await app.listen({ host: '127.0.0.1', port });
    const url = `http://127.0.0.1:${port}`;
    app.log.info({ url, contentDir: ctx.contentDir }, 'cms-insight ready');

    if (opts.open && loaded.config.open_browser) {
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
