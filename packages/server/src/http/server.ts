import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from '../app-context.js';
import { registerOverviewRoutes } from './routes/overview.js';
import { registerAnalysesRoutes } from './routes/analyses.js';
import { registerResultsRoutes } from './routes/results.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerActionsRoutes } from './routes/actions.js';

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

  app.get('/api/health', async () => ({ ok: true, contentDir: ctx.contentDir }));

  await registerOverviewRoutes(app, ctx);
  await registerAnalysesRoutes(app, ctx);
  await registerResultsRoutes(app, ctx);
  await registerSettingsRoutes(app, ctx);
  await registerActionsRoutes(app, ctx);

  app.setErrorHandler((err: Error, _req, reply) => {
    app.log.error(err);
    return reply.status(500).send({ error: err.message });
  });

  return app;
}
