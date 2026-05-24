import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { writeConfig } from '../../config/load.js';
import type { CmsInsightConfig } from '../../config/defaults.js';
import { reclassify403 } from '../../plugins/broken-links/reclassify.js';

function treat403(config: CmsInsightConfig): boolean {
  const bl = config.plugins?.['broken-links'] as { treat_403_as_broken?: boolean } | undefined;
  return bl?.treat_403_as_broken ?? false;
}

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
      const prev403 = treat403(ctx.config);
      const updated = await writeConfig(ctx.contentDir, req.body ?? {});
      ctx.refreshConfig(updated);

      // The 403 verdict is derivable from each link's stored http_status, so flip already-
      // checked 403s immediately rather than making the user run a full per-site re-check.
      let reclassified: { linksChanged: number; postsChanged: number } | undefined;
      const next403 = treat403(updated);
      if (next403 !== prev403) {
        const reg = ctx.runner.get('broken-links');
        if (reg) reclassified = await reclassify403(reg.storage, next403);
      }
      return { ok: true, config: updated, reclassified };
    },
  );
}
