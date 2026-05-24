import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph.js';
import { SCHEMA_VERSION, type OutgoingLink, type PostSidecar } from './sidecar.js';

function sidecar(
  type: PostSidecar['type'],
  slug: string,
  outgoing: OutgoingLink[],
): PostSidecar {
  return {
    schema_version: SCHEMA_VERSION,
    post_id: undefined,
    type,
    slug,
    file_path: `${type}s/${slug}.html`,
    body_hash: 'h',
    last_scanned: '2026-01-01T00:00:00.000Z',
    outgoing,
  };
}

function to(type: PostSidecar['type'], slug: string): OutgoingLink {
  return { target_type: type, target_slug: slug, anchors: [] };
}

describe('buildGraph', () => {
  const sidecars: PostSidecar[] = [
    sidecar('post', 'third-post', [to('post', 'second-post'), to('post', 'hello-world')]),
    sidecar('post', 'second-post', [to('page', 'about')]),
    sidecar('post', 'hello-world', []),
    sidecar('page', 'about', []),
    sidecar('post', 'orphan-post', []),
  ];
  const titles = new Map([
    ['post:third-post', 'Third post'],
    ['post:second-post', 'Second post'],
    ['post:hello-world', 'Hello, world'],
    ['page:about', 'About'],
    // orphan-post intentionally omitted to exercise the slug fallback.
  ]);
  const g = buildGraph(sidecars, titles);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  it('counts nodes and edges', () => {
    expect(g.totals.nodes).toBe(5);
    expect(g.totals.edges).toBe(3);
  });

  it('AC3: a post linked by nobody has in_degree 0', () => {
    expect(byId.get('post:third-post')?.in_degree).toBe(0);
    expect(byId.get('post:orphan-post')?.in_degree).toBe(0);
  });

  it('computes in/out degree from edges', () => {
    expect(byId.get('post:third-post')?.out_degree).toBe(2);
    expect(byId.get('post:hello-world')).toMatchObject({ in_degree: 1, out_degree: 0 });
    expect(byId.get('page:about')).toMatchObject({ in_degree: 1, out_degree: 0 });
  });

  it('AC4: out_degree 0 marks no-outgoing; both 0 marks isolated', () => {
    expect(byId.get('post:orphan-post')).toMatchObject({ in_degree: 0, out_degree: 0 });
    expect(g.totals.orphans_no_in).toBe(2); // third-post, orphan-post
    expect(g.totals.orphans_no_out).toBe(3); // hello-world, about, orphan-post
    expect(g.totals.isolated).toBe(1); // orphan-post
  });

  it('falls back to the slug when no title is supplied', () => {
    expect(byId.get('post:orphan-post')?.title).toBe('orphan-post');
    expect(byId.get('post:third-post')?.title).toBe('Third post');
  });

  it('deduplicates repeated edges to the same target', () => {
    const dup = [
      sidecar('post', 'a', [to('post', 'b'), to('post', 'b')]),
      sidecar('post', 'b', []),
    ];
    const result = buildGraph(dup, new Map());
    expect(result.totals.edges).toBe(1);
    expect(result.nodes.find((n) => n.id === 'post:b')?.in_degree).toBe(1);
  });

  it('drops edges whose target node does not exist', () => {
    const dangling = [sidecar('post', 'a', [to('post', 'ghost')])];
    const result = buildGraph(dangling, new Map());
    expect(result.totals.edges).toBe(0);
    expect(result.nodes.find((n) => n.id === 'post:a')?.out_degree).toBe(0);
  });
});
