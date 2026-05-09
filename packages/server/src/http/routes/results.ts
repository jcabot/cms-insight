import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PostType } from '@cms-insight/plugin-api';
import type { AppContext } from '../../app-context.js';
import {
  listAllSidecars as listBrokenLinksSidecars,
  loadIndex as loadBrokenLinksIndex,
  type LinkRecord,
  type PostSidecar as BrokenLinksSidecar,
} from '../../plugins/broken-links/sidecar.js';
import type { ApplyEdit } from '../../plugins/broken-links/apply.js';
import {
  listAllSidecars as listAltSidecars,
  loadIndex as loadAltIndex,
  type AltFinding,
  type PostSidecar as AltSidecar,
} from '../../plugins/missing-alt-text/sidecar.js';

interface FlatLink {
  postType: PostType;
  postSlug: string;
  postTitle: string | undefined;
  filePath: string;
  link: LinkRecord;
}

interface FlatAltFinding {
  postType: PostType;
  postSlug: string;
  postTitle: string | undefined;
  filePath: string;
  finding: AltFinding;
}

async function buildBrokenLinksResults(
  storage: import('@cms-insight/plugin-api').PluginStorage,
): Promise<{ index: unknown; links: FlatLink[] }> {
  const sidecars: BrokenLinksSidecar[] = [];
  for await (const sc of listBrokenLinksSidecars(storage)) sidecars.push(sc);
  const index = await loadBrokenLinksIndex(storage);
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
}

async function buildMissingAltResults(
  storage: import('@cms-insight/plugin-api').PluginStorage,
): Promise<{ index: unknown; findings: FlatAltFinding[] }> {
  const sidecars: AltSidecar[] = [];
  for await (const sc of listAltSidecars(storage)) sidecars.push(sc);
  const index = await loadAltIndex(storage);
  const flat: FlatAltFinding[] = [];
  for (const sc of sidecars) {
    for (const finding of sc.findings) {
      flat.push({
        postType: sc.type,
        postSlug: sc.slug,
        postTitle: undefined,
        filePath: sc.file_path,
        finding,
      });
    }
  }
  return { index, findings: flat };
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

      if (id === 'missing-alt-text') {
        return buildMissingAltResults(reg.storage);
      }
      // Default shape (broken-links and any other link-style plugin).
      return buildBrokenLinksResults(reg.storage);
    },
  );

  app.post(
    '/api/analyses/:id/apply',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: Record<string, unknown>;
      }>,
    ) => {
      const id = req.params.id;
      const reg = ctx.runner.get(id);
      if (!reg) return { ok: false, message: 'unknown plugin' };
      if (!reg.plugin.applyAction) {
        return { ok: false, message: 'plugin has no applyAction' };
      }
      const body = req.body;
      const kind = typeof body.kind === 'string' ? body.kind : undefined;

      // Broken-links' 'edit' payload needs siteUrl + stripParams injected from host context.
      // Other plugins' payloads pass through verbatim.
      const payload =
        id === 'broken-links' && (!kind || kind === 'edit')
          ? {
              kind: 'edit' as const,
              edits: (body as { edits: ApplyEdit[] }).edits,
              siteUrl: ctx.siteUrl,
              stripParams: ctx.config.strip_tracking_params,
            }
          : body;
      const result = await reg.plugin.applyAction(reg.applyCtx, payload);
      return result;
    },
  );
}
