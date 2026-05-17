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
    const entries = await Promise.all(
      ctx.runner.list().map(async (p) => {
        const run = ctx.runner.getRun(p.plugin.id);
        let lastRun: {
          status: 'running' | 'finished' | 'cancelled' | 'error';
          startedAt: string;
          finishedAt?: string;
          eventCount: number;
          lastEvent?: unknown;
        } | undefined;
        if (run) {
          lastRun = {
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            eventCount: run.events.length,
            lastEvent: run.events[run.events.length - 1],
          };
        } else {
          // Fall back to the sidecar index so prior-session runs survive a restart.
          const idx = await p.storage.read<{ last_run_completed?: string }>('index.json');
          if (idx?.last_run_completed) {
            lastRun = {
              status: 'finished',
              startedAt: idx.last_run_completed,
              finishedAt: idx.last_run_completed,
              eventCount: 0,
            };
          }
        }
        return {
          id: p.plugin.id,
          displayName: p.plugin.displayName,
          description: p.plugin.description,
          version: p.plugin.version,
          resultsView: p.plugin.resultsView,
          lastRun,
        };
      }),
    );
    return entries;
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
