import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { writeConfig } from '../../config/load.js';
import type { CmsInsightConfig } from '../../config/defaults.js';

export async function registerSettingsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get('/api/settings', async () => ({
    root: ctx.root,
    activeSiteId: ctx.activeSiteId,
    contentDir: ctx.contentDir,
    siteUrl: ctx.siteUrl,
    config: ctx.config,
    llmEnabled: ctx.runner.llmEnabled,
    llmDisabledReason: ctx.llmDisabledReason,
  }));

  app.put(
    '/api/settings',
    async (req: FastifyRequest<{ Body: Partial<CmsInsightConfig> }>, reply: FastifyReply) => {
      if (!ctx.activeSiteId) {
        return reply.status(409).send({ ok: false, message: 'no active site' });
      }
      const updated = await writeConfig(ctx.contentDir, req.body ?? {});
      ctx.refreshConfig(updated);
      return { ok: true, config: updated };
    },
  );
}
