import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { writeConfig } from '../../config/load.js';
import type { CmsInsightConfig } from '../../config/defaults.js';

export async function registerSettingsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get('/api/settings', async () => ({
    contentDir: ctx.contentDir,
    siteUrl: ctx.siteUrl,
    config: ctx.config,
    llmEnabled: ctx.runner.llmEnabled,
    llmDisabledReason: ctx.llmDisabledReason,
  }));

  app.put(
    '/api/settings',
    async (req: FastifyRequest<{ Body: Partial<CmsInsightConfig> }>) => {
      const updated = await writeConfig(ctx.contentDir, req.body ?? {});
      Object.assign(ctx.config, updated);
      return { ok: true, config: updated };
    },
  );

  app.post(
    '/api/settings/content-dir',
    async (
      req: FastifyRequest<{ Body: { contentDir?: string } }>,
      reply: FastifyReply,
    ) => {
      const newDir = req.body?.contentDir;
      if (typeof newDir !== 'string' || newDir.trim().length === 0) {
        return reply.status(400).send({ ok: false, message: 'contentDir is required' });
      }
      try {
        await ctx.reload(newDir);
        return { ok: true, contentDir: ctx.contentDir, siteUrl: ctx.siteUrl };
      } catch (err) {
        return reply.status(400).send({ ok: false, message: (err as Error).message });
      }
    },
  );
}
