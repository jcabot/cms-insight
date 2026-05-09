import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { loadAllPosts } from '../../content/scan.js';
import { computeOverview, type OverviewSummary } from '../../overview/compute.js';

const TTL_MS = 30_000;

export async function registerOverviewRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  let cached:
    | { dir: string; value: OverviewSummary & { contentDir: string; siteUrl: string }; at: number }
    | undefined;
  let inflight: Promise<OverviewSummary & { contentDir: string; siteUrl: string }> | undefined;

  async function compute(): Promise<OverviewSummary & { contentDir: string; siteUrl: string }> {
    const posts = await loadAllPosts(ctx.contentDir);
    return { contentDir: ctx.contentDir, siteUrl: ctx.siteUrl, ...computeOverview(posts) };
  }

  app.get('/api/overview', async (req, reply) => {
    if (!ctx.activeSiteId) {
      return reply.status(409).send({ error: 'no active site' });
    }
    const force = (req.query as { fresh?: string } | undefined)?.fresh === '1';
    const now = Date.now();
    if (!force && cached && cached.dir === ctx.contentDir && now - cached.at < TTL_MS) {
      return cached.value;
    }
    if (!inflight) {
      const dirAtStart = ctx.contentDir;
      inflight = compute().finally(() => {
        inflight = undefined;
      });
      const value = await inflight;
      cached = { dir: dirAtStart, value, at: Date.now() };
      return value;
    }
    return inflight;
  });
}
