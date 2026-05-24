import PQueue from 'p-queue';
import { request as undiciRequest, Agent, type Dispatcher } from 'undici';
import { hostOf, registrableDomain } from './url.js';
import { classify, type ClassifierRules } from './classifier/rules.js';
import type { Verdict } from './sidecar.js';
import { verdictFor403 } from './verdict-403.js';

export interface CheckResult {
  http_status?: number;
  final_url?: string;
  verdict: Verdict;
  reason_code: string;
  reason_detail?: string;
  cross_domain_redirect?: boolean;
}

export interface CheckerConfig {
  concurrency_global: number;
  concurrency_per_host: number;
  per_host_min_delay_ms: number;
  timeout_ms?: number;
  redirect_max?: number;
  body_cap_bytes?: number;
  user_agent: string;
  retry_attempts?: number;
  treat_403_as_broken?: boolean;
}

export interface Checker {
  check(opts: { href: string; anchorText: string; signal: AbortSignal }): Promise<CheckResult>;
  close(): Promise<void>;
}

class PerHostQueue {
  private queues = new Map<string, PQueue>();
  private lastStart = new Map<string, number>();

  constructor(
    private readonly concurrency: number,
    private readonly minDelay: number,
  ) {}

  private getQueue(host: string): PQueue {
    let q = this.queues.get(host);
    if (!q) {
      q = new PQueue({ concurrency: this.concurrency });
      this.queues.set(host, q);
    }
    return q;
  }

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const q = this.getQueue(host);
    const result = await q.add(async () => {
      const last = this.lastStart.get(host) ?? 0;
      const elapsed = Date.now() - last;
      if (elapsed < this.minDelay) {
        await new Promise((r) => setTimeout(r, this.minDelay - elapsed));
      }
      this.lastStart.set(host, Date.now());
      return fn();
    });
    return result as T;
  }

  get queueCount(): number {
    return this.queues.size;
  }
}

const TRANSIENT_STATUS = new Set([502, 503, 504]);
const TRANSIENT_ERRORS = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

interface FetchResult {
  status: number;
  finalUrl: string;
  body: string;
  contentType: string;
  crossDomainRedirect: boolean;
  retryAfterMs?: number;
}

export function createChecker(config: CheckerConfig, rules: ClassifierRules): Checker {
  const dispatcher: Dispatcher = new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
    connections: config.concurrency_global * 2,
  });
  const globalQueue = new PQueue({ concurrency: config.concurrency_global });
  const hostQueue = new PerHostQueue(config.concurrency_per_host, config.per_host_min_delay_ms);
  const timeoutMs = config.timeout_ms ?? 15_000;
  const redirectMax = config.redirect_max ?? 5;
  const bodyCap = config.body_cap_bytes ?? 1_048_576;
  const retryAttempts = config.retry_attempts ?? 1;

  // Per-run cache so the same final URL is only fetched once
  const cache = new Map<string, Promise<CheckResult>>();

  async function readBody(stream: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > bodyCap) {
        chunks.push(buf.subarray(0, Math.max(0, bodyCap - (total - buf.length))));
        break;
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function singleRequest(
    method: 'HEAD' | 'GET',
    url: string,
    signal: AbortSignal,
  ): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: NodeJS.ReadableStream;
  }> {
    const ac = new AbortController();
    const onParentAbort = (): void => ac.abort();
    signal.addEventListener('abort', onParentAbort);
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await undiciRequest(url, {
        method,
        signal: ac.signal,
        dispatcher,
        headers: { 'user-agent': config.user_agent, accept: '*/*' },
        maxRedirections: 0,
      });
      return { status: res.statusCode, headers: res.headers, body: res.body };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
    }
  }

  function drainBody(body: NodeJS.ReadableStream): void {
    try {
      body.resume();
    } catch {
      /* ignore */
    }
  }

  function isRedirect(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }

  async function fetchOnce(href: string, signal: AbortSignal): Promise<FetchResult> {
    const originalDomain = registrableDomain(href);
    let current = href;
    let redirects = 0;
    while (true) {
      let response: { status: number; headers: Record<string, string | string[] | undefined>; body: NodeJS.ReadableStream };
      try {
        response = await singleRequest('HEAD', current, signal);
      } catch {
        response = await singleRequest('GET', current, signal);
      }

      if (
        !isRedirect(response.status) &&
        (response.status === 405 || response.status === 501 || response.status === 400)
      ) {
        drainBody(response.body);
        response = await singleRequest('GET', current, signal);
      }

      if (isRedirect(response.status)) {
        const loc = String(response.headers['location'] ?? '');
        drainBody(response.body);
        if (!loc) {
          return {
            status: response.status,
            finalUrl: current,
            body: '',
            contentType: '',
            crossDomainRedirect: false,
          };
        }
        redirects++;
        if (redirects > redirectMax) throw new Error(`too many redirects (>${redirectMax})`);
        current = new URL(loc, current).toString();
        continue;
      }

      const ct = String(response.headers['content-type'] ?? '');
      const wantBody = response.status >= 200 && response.status < 400 && ct.includes('html');
      const body = wantBody ? await readBody(response.body) : '';
      if (!wantBody) drainBody(response.body);

      const finalDomain = registrableDomain(current);
      const cross =
        !!originalDomain && !!finalDomain && originalDomain !== finalDomain;

      let retryAfterMs: number | undefined;
      if (response.status === 429 || response.status === 503) {
        const ra = response.headers['retry-after'];
        if (typeof ra === 'string') {
          const n = Number(ra);
          retryAfterMs = Number.isFinite(n) ? n * 1000 : undefined;
        }
      }

      return {
        status: response.status,
        finalUrl: current,
        body,
        contentType: ct,
        crossDomainRedirect: cross,
        retryAfterMs,
      };
    }
  }

  async function withRetries(href: string, signal: AbortSignal): Promise<FetchResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      try {
        const result = await fetchOnce(href, signal);
        if (TRANSIENT_STATUS.has(result.status) && attempt < retryAttempts) {
          const wait = result.retryAfterMs ?? 1000;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        return result;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (signal.aborted) throw err;
        if (TRANSIENT_ERRORS.has(code) && attempt < retryAttempts) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error('fetch failed');
  }

  function classifyError(err: unknown): CheckResult {
    const e = err as NodeJS.ErrnoException;
    const code = e.code ?? '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
      return { verdict: 'BROKEN', reason_code: 'dns_failure', reason_detail: e.message };
    }
    if (code === 'UND_ERR_ABORTED' || e.name === 'AbortError') {
      return { verdict: 'BROKEN', reason_code: 'network_aborted', reason_detail: e.message };
    }
    if (e.message?.toLowerCase().includes('redirects')) {
      return { verdict: 'BROKEN', reason_code: 'too_many_redirects', reason_detail: e.message };
    }
    return {
      verdict: 'BROKEN',
      reason_code: code ? `network_${code}` : 'network_error',
      reason_detail: e.message,
    };
  }

  async function checkOne(href: string, anchorText: string, signal: AbortSignal): Promise<CheckResult> {
    const host = hostOf(href);
    if (!host) {
      return { verdict: 'BROKEN', reason_code: 'invalid_url' };
    }
    return globalQueue.add(() =>
      hostQueue.run(host, async () => {
        try {
          const r = await withRetries(href, signal);
          if (r.status === 403) {
            return {
              http_status: r.status,
              final_url: r.finalUrl,
              ...verdictFor403(!!config.treat_403_as_broken),
              cross_domain_redirect: r.crossDomainRedirect,
            };
          }
          if (r.status >= 400) {
            return {
              http_status: r.status,
              final_url: r.finalUrl,
              verdict: 'BROKEN',
              reason_code: `http_${r.status}`,
              reason_detail: undefined,
              cross_domain_redirect: r.crossDomainRedirect,
            };
          }
          const verdict = classify(
            {
              status: r.status,
              finalUrl: r.finalUrl,
              originalHref: href,
              body: r.body,
              contentType: r.contentType,
              crossDomainRedirect: r.crossDomainRedirect,
              anchorText,
            },
            rules,
          );
          return {
            http_status: r.status,
            final_url: r.finalUrl,
            verdict: verdict.verdict,
            reason_code: verdict.reason_code,
            reason_detail: verdict.reason_detail,
            cross_domain_redirect: r.crossDomainRedirect,
          };
        } catch (err) {
          return classifyError(err);
        }
      }),
    ) as Promise<CheckResult>;
  }

  return {
    async check(opts) {
      const cached = cache.get(opts.href);
      if (cached) return cached;
      const p = checkOne(opts.href, opts.anchorText, opts.signal);
      cache.set(opts.href, p);
      return p;
    },
    async close(): Promise<void> {
      await dispatcher.close();
    },
  };
}
