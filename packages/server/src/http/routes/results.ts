import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PostType } from '@cms-insight/plugin-api';
import type { AppContext } from '../../app-context.js';
import {
  listAllSidecars,
  loadIndex,
  type LinkRecord,
  type PostSidecar,
} from '../../plugins/broken-links/sidecar.js';
import type { ApplyEdit } from '../../plugins/broken-links/apply.js';

interface FlatLink {
  postType: PostType;
  postSlug: string;
  postTitle: string | undefined;
  filePath: string;
  link: LinkRecord;
}

export async function registerResultsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get(
    '/api/analyses/:id/results',
    async (req: FastifyRequest<{ Params: { id: string } }>) => {
      const id = req.params.id;
      const reg = ctx.runner.get(id);
      if (!reg) return { error: 'unknown plugin' };

      const sidecars: PostSidecar[] = [];
      for await (const sc of listAllSidecars(reg.storage)) sidecars.push(sc);
      const index = await loadIndex(reg.storage);

      const flat: FlatLink[] = [];
      for (const sc of sidecars) {
        for (const link of sc.links) {
          flat.push({
            postType: sc.type,
            postSlug: sc.slug,
            postTitle: undefined,
            filePath: sc.file_path,
            link,
          });
        }
      }
      return { index, links: flat };
    },
  );

  app.post(
    '/api/analyses/:id/apply',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body:
          | { kind?: 'edit'; edits: ApplyEdit[] }
          | { kind: 'clean-suggestion' | 'reset-suggestion'; postType: PostType; slug: string; linkId: string };
      }>,
    ) => {
      const id = req.params.id;
      const reg = ctx.runner.get(id);
      if (!reg) return { ok: false, message: 'unknown plugin' };
      if (!reg.plugin.applyAction) {
        return { ok: false, message: 'plugin has no applyAction' };
      }
      const body = req.body;
      const payload =
        'kind' in body && (body.kind === 'clean-suggestion' || body.kind === 'reset-suggestion')
          ? body
          : {
              kind: 'edit' as const,
              edits: (body as { edits: ApplyEdit[] }).edits,
              siteUrl: ctx.siteUrl,
              stripParams: ctx.config.strip_tracking_params,
            };
      const result = await reg.plugin.applyAction(reg.applyCtx, payload);
      return result;
    },
  );
}
