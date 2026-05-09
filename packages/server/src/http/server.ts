import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppContext } from '../app-context.js';
import { registerOverviewRoutes } from './routes/overview.js';
import { registerAnalysesRoutes } from './routes/analyses.js';
import { registerResultsRoutes } from './routes/results.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerActionsRoutes } from './routes/actions.js';
import { registerSitesRoutes } from './routes/sites.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// dist layout: packages/server/dist/http/server.js → packages/web/dist
const webDist = path.resolve(moduleDir, '../../../web/dist');

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

  app.get('/api/health', async () => ({ ok: true, contentDir: ctx.contentDir }));

  await registerSitesRoutes(app, ctx);
  await registerOverviewRoutes(app, ctx);
  await registerAnalysesRoutes(app, ctx);
  await registerResultsRoutes(app, ctx);
  await registerSettingsRoutes(app, ctx);
  await registerActionsRoutes(app, ctx);

  const hasWebBundle = existsSync(path.join(webDist, 'index.html'));
  if (hasWebBundle) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply
        .status(404)
        .send({ error: 'Not Found', message: `Route ${req.method}:${req.url} not found`, statusCode: 404 });
    });
  } else {
    app.log.warn({ webDist }, 'web bundle not found — UI will not be served. Run `pnpm -r build`.');
  }

  app.setErrorHandler((err: Error, _req, reply) => {
    app.log.error(err);
    return reply.status(500).send({ error: err.message });
  });

  return app;
}
