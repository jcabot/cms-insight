import { describe, expect, it } from 'vitest';
import type {
  AnalysisContext,
  ParsedPost,
  PluginStorage,
  PostType,
  ProgressEvent,
} from '@cms-insight/plugin-api';
import plugin from './index.js';
import type { GraphIndex } from './sidecar.js';

class MemStorage implements PluginStorage {
  readonly rootDir = '/mem';
  private readonly files = new Map<string, string>();

  async read<T>(key: string): Promise<T | undefined> {
    const raw = this.files.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async write(key: string, value: unknown): Promise<void> {
    this.files.set(key, JSON.stringify(value));
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
  async *list(prefix?: string): AsyncIterable<string> {
    for (const key of this.files.keys()) {
      if (!prefix || key.startsWith(prefix)) yield key;
    }
  }
}

interface PostSpec {
  id: number;
  type: PostType;
  slug: string;
  title: string;
  body: string;
  bodyHash: string;
}

function makePosts(specs: PostSpec[], bodyCalls: Map<string, number>): ParsedPost[] {
  return specs.map((s) => ({
    id: s.id,
    type: s.type,
    slug: s.slug,
    title: s.title,
    status: 'publish',
    filePath: `${s.type}s/${s.slug}.html`,
    bodyHash: s.bodyHash,
    body: async () => {
      bodyCalls.set(s.slug, (bodyCalls.get(s.slug) ?? 0) + 1);
      return s.body;
    },
  }));
}

function makeContext(posts: ParsedPost[], storage: PluginStorage): AnalysisContext {
  return {
    contentDir: '/content',
    siteUrl: 'https://example.com',
    posts: (async function* () {
      for (const p of posts) yield p;
    })(),
    storage,
    signal: new AbortController().signal,
    config: { runOptions: {} },
  };
}

async function drain(gen: AsyncIterable<ProgressEvent>): Promise<ProgressEvent[]> {
  const out: ProgressEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const SPECS: PostSpec[] = [
  { id: 1, type: 'post', slug: 'hello-world', title: 'Hello, world', bodyHash: 'h1',
    body: '<a href="https://example.org/">ext</a>' },
  { id: 2, type: 'post', slug: 'second-post', title: 'Second post', bodyHash: 'h2',
    body: '<a href="/about">about</a>' },
  { id: 3, type: 'post', slug: 'third-post', title: 'Third post', bodyHash: 'h3',
    body:
      '<a href="/second-post/">a</a><a href="https://example.com/second-post/">b</a>' +
      '<a href="https://example.com/?p=1">c</a>' +
      '<a href="/draft-post/">draft</a><a href="/third-post/">self</a>' },
  { id: 100, type: 'page', slug: 'about', title: 'About', bodyHash: 'h100',
    body: '<a href="https://example.org">ext</a>' },
  { id: 4, type: 'post', slug: 'orphan-post', title: 'Orphan post', bodyHash: 'h4',
    body: '<a href="https://example.org/">ext</a>' },
];

describe('link-graph plugin run', () => {
  it('builds graph.json with correct nodes, edges, and orphan totals', async () => {
    const storage = new MemStorage();
    const events = await drain(
      plugin.run(makeContext(makePosts(SPECS, new Map()), storage)),
    );

    const graph = (await storage.read<GraphIndex>('index.json'))!;
    expect(graph.totals).toMatchObject({
      nodes: 5,
      edges: 3, // third→second, third→hello (via ?p=1), second→about
      orphans_no_in: 2, // third-post, orphan-post
      isolated: 1, // orphan-post
    });

    const finished = events.at(-1);
    expect(finished).toEqual({
      kind: 'finished',
      summary: '5 posts · 3 internal links · 2 orphans',
    });
  });

  it('AC8: an unchanged body_hash skips re-extraction on re-run', async () => {
    const storage = new MemStorage();
    const firstCalls = new Map<string, number>();
    await drain(plugin.run(makeContext(makePosts(SPECS, firstCalls), storage)));
    expect([...firstCalls.values()].every((n) => n === 1)).toBe(true);

    // Second run against the same hashes: no body should be read again.
    const secondCalls = new Map<string, number>();
    await drain(plugin.run(makeContext(makePosts(SPECS, secondCalls), storage)));
    expect(secondCalls.size).toBe(0);
  });

  it('re-extracts only the post whose body_hash changed', async () => {
    const storage = new MemStorage();
    await drain(plugin.run(makeContext(makePosts(SPECS, new Map()), storage)));

    const changed = SPECS.map((s) =>
      s.slug === 'second-post' ? { ...s, bodyHash: 'h2-new' } : s,
    );
    const calls = new Map<string, number>();
    await drain(plugin.run(makeContext(makePosts(changed, calls), storage)));
    expect([...calls.keys()]).toEqual(['second-post']);
  });
});
