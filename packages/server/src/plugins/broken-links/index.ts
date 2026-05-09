import type {
  AnalysisContext,
  AnalysisPlugin,
  ParsedPost,
  PluginStorage,
  ProgressEvent,
} from '@cms-insight/plugin-api';
import { loadRules } from './classifier/rules.js';
import { createChecker, type CheckerConfig } from './check.js';
import {
  buildIndex,
  listAllSidecars,
  loadIndex,
  loadSidecar,
  saveIndex,
  saveSidecar,
  SCHEMA_VERSION,
  type LinkRecord,
  type PostSidecar,
} from './sidecar.js';
import { buildLinkRecords } from './build-records.js';
import { applyAction } from './apply.js';
import { suggestReplacements } from './suggest/index.js';
import manifest from './manifest.json' with { type: 'json' };

interface RunConfig {
  port: number;
  post_statuses: string[];
  concurrency_global: number;
  concurrency_per_host: number;
  per_host_min_delay_ms: number;
  ttl_ok_days: number;
  ttl_suspicious_days: number;
  ttl_broken_days: number;
  strip_tracking_params: string[];
  runOptions?: { fullRecheck?: boolean; reExtractAll?: boolean };
}

const VERSION = '0.1.0';

function ttlMs(verdict: string | undefined, cfg: RunConfig): number {
  switch (verdict) {
    case 'OK':
      return cfg.ttl_ok_days * 86_400_000;
    case 'SUSPICIOUS':
      return cfg.ttl_suspicious_days * 86_400_000;
    case 'BROKEN':
      return cfg.ttl_broken_days * 86_400_000;
    default:
      return 0;
  }
}

function isCheckDue(link: LinkRecord, cfg: RunConfig, fullRecheck: boolean): boolean {
  if (link.not_editable) return false;
  if (fullRecheck) return true;
  const lc = link.last_check;
  if (!lc) return true;
  const checkedAt = Date.parse(lc.checked_at);
  if (!Number.isFinite(checkedAt)) return true;
  const due = checkedAt + ttlMs(lc.verdict, cfg);
  return Date.now() >= due;
}

async function* runPlugin(ctx: AnalysisContext): AsyncIterable<ProgressEvent> {
  const cfg = ctx.config as RunConfig;
  const opts = cfg.runOptions ?? {};
  const fullRecheck = !!opts.fullRecheck;
  const reExtractAll = !!opts.reExtractAll;

  yield { kind: 'started' };

  // Phase A: extract per post.
  const allPosts: ParsedPost[] = [];
  for await (const p of ctx.posts) {
    if (ctx.signal.aborted) {
      yield { kind: 'finished', summary: 'cancelled before scan' };
      return;
    }
    allPosts.push(p);
  }

  const total = allPosts.length;
  yield {
    kind: 'progress',
    done: 0,
    total,
    message: `Scanning ${total} post(s)...`,
  };

  const sidecars: PostSidecar[] = [];

  for (let i = 0; i < allPosts.length; i++) {
    if (ctx.signal.aborted) break;
    const p = allPosts[i];
    if (!p) continue;

    let sc = await loadSidecar(ctx.storage, p.type, p.slug);
    const needsExtract = reExtractAll || !sc || sc.body_hash !== p.bodyHash;

    if (needsExtract) {
      const body = await p.body();
      const previousByHref = sc ? indexByHref(sc.links) : undefined;
      const fresh = buildLinkRecords({
        body,
        bodyHash: p.bodyHash,
        postId: p.id ?? 0,
        siteUrl: ctx.siteUrl,
        stripParams: cfg.strip_tracking_params,
        previousByHref,
      });
      sc = {
        schema_version: SCHEMA_VERSION,
        post_id: p.id,
        type: p.type,
        slug: p.slug,
        file_path: p.filePath,
        body_hash: p.bodyHash,
        last_scanned: new Date().toISOString(),
        links: fresh,
      };
      await saveSidecar(ctx.storage, sc);
    }
    sidecars.push(sc!);
    yield {
      kind: 'progress',
      done: i + 1,
      total,
      message: `Scanned ${i + 1}/${total}: ${p.type}/${p.slug}`,
    };
  }

  if (ctx.signal.aborted) {
    yield { kind: 'finished', summary: 'cancelled during extraction' };
    return;
  }

  // Phase B: check links that are due.
  const rules = await loadRules(ctx.contentDir);
  const checkerConfig: CheckerConfig = {
    concurrency_global: cfg.concurrency_global,
    concurrency_per_host: cfg.concurrency_per_host,
    per_host_min_delay_ms: cfg.per_host_min_delay_ms,
    user_agent: `cms-insight/${VERSION} (+${ctx.siteUrl})`,
  };
  const checker = createChecker(checkerConfig, rules);

  interface DueLink {
    sidecar: PostSidecar;
    link: LinkRecord;
  }
  const due: DueLink[] = [];
  for (const sc of sidecars) {
    for (const link of sc.links) {
      if (isCheckDue(link, cfg, fullRecheck)) due.push({ sidecar: sc, link });
    }
  }

  yield {
    kind: 'progress',
    done: 0,
    total: due.length,
    message: `Checking ${due.length} link(s) (skipped ${countSkipped(sidecars)} fresh)...`,
  };

  let doneCount = 0;
  let okCount = 0;
  let suspiciousCount = 0;
  let brokenCount = 0;

  // Group by sidecar for batched flushing
  const bySidecar = new Map<PostSidecar, DueLink[]>();
  for (const d of due) {
    const arr = bySidecar.get(d.sidecar) ?? [];
    arr.push(d);
    bySidecar.set(d.sidecar, arr);
  }

  // Producer/consumer queue so per-link progress flows out of the parallel checker
  // tasks without being blocked behind the final Promise.all. Without this, sites
  // with hundreds of due links show no progress for minutes.
  const queue: ProgressEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const emit = (ev: ProgressEvent): void => {
    queue.push(ev);
    wake?.();
    wake = undefined;
  };

  // Cap the number of progress emissions at ~one per percent for huge sites,
  // and emit at least every link for small ones.
  const stride = Math.max(1, Math.floor(due.length / 100));

  const work = Promise.all(
    [...bySidecar.entries()].map(async ([sc, links]) => {
      for (const d of links) {
        if (ctx.signal.aborted) return;
        const result = await checker.check({
          href: d.link.href,
          anchorText: d.link.anchor_text,
          signal: ctx.signal,
        });
        d.link.last_check = {
          checked_at: new Date().toISOString(),
          http_status: result.http_status,
          final_url: result.final_url,
          verdict: result.verdict,
          reason_code: result.reason_code,
          reason_detail: result.reason_detail,
          cross_domain_redirect: result.cross_domain_redirect,
        };
        doneCount++;
        if (result.verdict === 'OK') okCount++;
        else if (result.verdict === 'SUSPICIOUS') suspiciousCount++;
        else brokenCount++;
        if (doneCount === due.length || doneCount % stride === 0) {
          emit({
            kind: 'progress',
            done: doneCount,
            total: due.length,
            message: `Checked ${doneCount}/${due.length} · ok ${okCount}, suspicious ${suspiciousCount}, broken ${brokenCount}`,
          });
        }
      }
      try {
        await saveSidecar(ctx.storage, sc);
      } catch (err) {
        console.warn(`saveSidecar failed for ${sc.slug}: ${(err as Error).message}`);
      }
    }),
  ).finally(() => {
    closed = true;
    wake?.();
    wake = undefined;
  });

  // Drain progress events as they arrive until all checker tasks have settled.
  while (!closed || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((r) => {
        wake = r;
      });
      continue;
    }
    const ev = queue.shift();
    if (ev) yield ev;
  }
  await work; // surface any errors that escaped Promise.all

  await checker.close();

  // Rebuild index from all sidecars on disk
  const allSc: PostSidecar[] = [];
  for await (const sc of listAllSidecars(ctx.storage)) {
    allSc.push(sc);
  }
  const idx = buildIndex(allSc);
  await saveIndex(ctx.storage, idx);

  yield {
    kind: 'finished',
    summary: `Scanned ${total} post(s); checked ${doneCount} link(s); broken ${idx.totals.broken}, suspicious ${idx.totals.suspicious}, ok ${idx.totals.ok}`,
  };
}

function indexByHref(links: ReadonlyArray<LinkRecord>): Map<string, LinkRecord> {
  const out = new Map<string, LinkRecord>();
  for (const l of links) if (!out.has(l.href)) out.set(l.href, l);
  return out;
}

function countSkipped(sidecars: ReadonlyArray<PostSidecar>): number {
  let n = 0;
  for (const sc of sidecars) {
    for (const l of sc.links) if (l.last_check) n++;
  }
  return n;
}

async function formatHeadline(storage: PluginStorage): Promise<string | undefined> {
  const idx = await loadIndex(storage);
  if (!idx) return undefined;
  const checked = idx.totals.ok + idx.totals.suspicious + idx.totals.broken;
  return `${idx.totals.broken} broken / ${checked} checked`;
}

const plugin: AnalysisPlugin = {
  id: manifest.id,
  displayName: manifest.displayName,
  description: manifest.description,
  version: manifest.version,
  storageSchemaVersion: manifest.storageSchemaVersion,
  resultsView: 'broken-links',
  run: runPlugin,
  applyAction,
  formatHeadline,
  auxiliaryActions: {
    'suggest-replacements': {
      id: 'suggest-replacements',
      displayName: 'Suggest replacements',
      description:
        'Use an LLM to propose replacement URLs for broken links. Batched per ~20 links; cost-conscious.',
      requiresLlm: true,
      inputSchema: {
        type: 'object',
        properties: { force: { type: 'boolean' } },
      },
      run: suggestReplacements,
    },
  },
};

export default plugin;
