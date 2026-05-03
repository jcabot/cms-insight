import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { attachSse } from '../sse.js';

interface RunBody {
  fullRecheck?: boolean;
  reExtractAll?: boolean;
}

export async function registerAnalysesRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get('/api/analyses', async () => {
    return ctx.runner.list().map((p) => {
      const run = ctx.runner.getRun(p.plugin.id);
      return {
        id: p.plugin.id,
        displayName: p.plugin.displayName,
        description: p.plugin.description,
        version: p.plugin.version,
        resultsView: p.plugin.resultsView,
        lastRun: run
          ? {
              status: run.status,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              eventCount: run.events.length,
              lastEvent: run.events[run.events.length - 1],
            }
          : undefined,
      };
    });
  });

  app.post(
    '/api/analyses/:id/run',
    async (req: FastifyRequest<{ Params: { id: string }; Body?: RunBody }>) => {
      const id = req.params.id;
      const body = (req.body ?? {}) as RunBody;
      const state = await ctx.runner.startRun(id, {
        fullRecheck: !!body.fullRecheck,
        reExtractAll: !!body.reExtractAll,
      });
      return state;
    },
  );

  app.post(
    '/api/analyses/:id/cancel',
    async (req: FastifyRequest<{ Params: { id: string } }>) => {
      const cancelled = ctx.runner.cancelRun(req.params.id);
      return { cancelled };
    },
  );

  app.get('/api/analyses/:id/stream', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const sse = attachSse(reply);
    const unsub = ctx.runner.subscribe(id, (ev) => {
      if ('kind' in ev && ev.kind === 'closed') {
        sse.send('closed', { status: ev.status });
        sse.close();
      } else {
        sse.send('progress', ev);
      }
    });
    req.raw.on('close', () => {
      unsub();
      sse.close();
    });
    return reply;
  });
}
