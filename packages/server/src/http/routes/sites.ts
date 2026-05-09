import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../app-context.js';
import { loadAllPosts } from '../../content/scan.js';

interface AddSiteBody {
  relPath?: string;
  label?: string;
}

interface RenameBody {
  label?: string;
}

interface ReorderBody {
  ids?: string[];
}

function siteToDto(ctx: AppContext, id: string): unknown {
  const s = ctx.registry.get(id);
  if (!s) return undefined;
  return {
    id: s.id,
    label: s.label,
    relPath: s.relPath,
    addedAt: s.addedAt,
    postCount: s.postCount,
    lastAnalyses: s.lastAnalyses ?? {},
    isActive: ctx.activeSiteId === s.id,
  };
}

async function tryRefreshPostCount(ctx: AppContext, id: string): Promise<void> {
  try {
    const site = ctx.registry.get(id);
    if (!site) return;
    const dir = path.join(ctx.root, site.relPath);
    const posts = await loadAllPosts(dir);
    await ctx.registry.refreshPostCount(id, posts.length);
  } catch {
    // Best-effort; failures shouldn't block the request.
  }
}

export async function registerSitesRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get('/api/sites', async () => {
    return {
      root: ctx.root,
      activeSiteId: ctx.activeSiteId,
      sites: ctx.registry.list().map((s) => siteToDto(ctx, s.id)),
    };
  });

  app.post(
    '/api/sites',
    async (req: FastifyRequest<{ Body: AddSiteBody }>, reply: FastifyReply) => {
      const relPath = req.body?.relPath?.trim();
      if (!relPath) return reply.status(400).send({ error: 'relPath is required' });
      try {
        const entry = await ctx.registry.addSite({ relPath, label: req.body?.label });
        // Best-effort initial post count.
        await tryRefreshPostCount(ctx, entry.id);
        // If this is the very first site, make it active automatically.
        if (!ctx.activeSiteId) {
          try {
            await ctx.setActiveSite(entry.id);
          } catch (err) {
            app.log.warn({ err }, 'failed to auto-activate first site');
          }
        }
        return { ok: true, site: siteToDto(ctx, entry.id) };
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  app.patch(
    '/api/sites/:id',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: RenameBody }>,
      reply: FastifyReply,
    ) => {
      const { id } = req.params;
      const label = req.body?.label;
      if (typeof label !== 'string') {
        return reply.status(400).send({ error: 'label is required' });
      }
      try {
        await ctx.registry.rename(id, label);
        return { ok: true, site: siteToDto(ctx, id) };
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  app.delete(
    '/api/sites/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const wasActive = ctx.activeSiteId === id;
      try {
        await ctx.registry.removeSite(id);
        if (wasActive) {
          // Pick the new first site, if any.
          const next = ctx.registry.list()[0]?.id;
          await ctx.setActiveSite(next);
        }
        return {
          ok: true,
          activeSiteId: ctx.activeSiteId,
          sites: ctx.registry.list().map((s) => siteToDto(ctx, s.id)),
        };
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  app.put(
    '/api/sites/order',
    async (req: FastifyRequest<{ Body: ReorderBody }>, reply: FastifyReply) => {
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
        return reply.status(400).send({ error: 'ids[] is required' });
      }
      try {
        await ctx.registry.reorder(ids);
        return { ok: true, sites: ctx.registry.list().map((s) => siteToDto(ctx, s.id)) };
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post(
    '/api/sites/:id/activate',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      try {
        await ctx.setActiveSite(id);
        return {
          ok: true,
          activeSiteId: ctx.activeSiteId,
          contentDir: ctx.contentDir,
          siteUrl: ctx.siteUrl,
        };
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post(
    '/api/sites/:id/refresh',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const site = ctx.registry.get(id);
      if (!site) return reply.status(404).send({ error: 'unknown site' });
      try {
        const posts = await loadAllPosts(path.join(ctx.root, site.relPath));
        await ctx.registry.refreshPostCount(id, posts.length);
        return { ok: true, site: siteToDto(ctx, id) };
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  // Suggest candidate subfolders inside the root that look like wpsync content dirs.
  app.get('/api/sites/candidates', async () => {
    const entries = await fs.readdir(ctx.root, { withFileTypes: true }).catch(() => []);
    const taken = new Set(ctx.registry.list().map((s) => s.relPath));
    const out: { relPath: string; siteUrl?: string }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      if (taken.has(e.name)) continue;
      const wpsyncCfg = path.join(ctx.root, e.name, '.wpsync', 'config.toml');
      try {
        await fs.access(wpsyncCfg);
        out.push({ relPath: e.name });
      } catch {
        /* not a wpsync dir; skip */
      }
    }
    return { candidates: out };
  });
}
