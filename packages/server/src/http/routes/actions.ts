import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { attachSse } from '../sse.js';

export async function registerActionsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get(
    '/api/analyses/:pluginId/actions',
    async (req: FastifyRequest<{ Params: { pluginId: string } }>, reply: FastifyReply) => {
      const reg = ctx.runner.get(req.params.pluginId);
      if (!reg) return reply.status(404).send({ error: 'unknown plugin' });
      return ctx.runner.listActions(req.params.pluginId);
    },
  );

  app.post(
    '/api/analyses/:pluginId/actions/:actionName/start',
    async (
      req: FastifyRequest<{
        Params: { pluginId: string; actionName: string };
        Body?: unknown;
      }>,
      reply: FastifyReply,
    ) => {
      const { pluginId, actionName } = req.params;
      const reg = ctx.runner.get(pluginId);
      if (!reg) return reply.status(404).send({ error: 'unknown plugin' });
      const action = reg.plugin.auxiliaryActions?.[actionName];
      if (!action) return reply.status(404).send({ error: 'unknown action' });
      if (action.requiresLlm && !ctx.runner.llmEnabled) {
        return reply.status(503).send({
          error: 'LLM features disabled',
          reason: ctx.llmDisabledReason ?? 'no provider configured',
        });
      }
      try {
        const state = await ctx.runner.startAction(pluginId, actionName, req.body ?? {});
        return state;
      } catch (err) {
        return reply.status(409).send({ error: (err as Error).message });
      }
    },
  );

  app.post(
    '/api/analyses/:pluginId/actions/:actionName/cancel',
    async (
      req: FastifyRequest<{ Params: { pluginId: string; actionName: string } }>,
    ) => {
      const cancelled = ctx.runner.cancelAction(req.params.pluginId, req.params.actionName);
      return { cancelled };
    },
  );

  app.get(
    '/api/analyses/:pluginId/actions/:actionName/stream',
    async (
      req: FastifyRequest<{ Params: { pluginId: string; actionName: string } }>,
      reply: FastifyReply,
    ) => {
      const { pluginId, actionName } = req.params;
      const sse = attachSse(reply);
      const unsub = ctx.runner.subscribeAction(pluginId, actionName, (ev) => {
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
    },
  );
}
