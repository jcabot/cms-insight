import { SCHEMA_VERSION, type GraphIndex, type GraphNode, type PostSidecar } from './sidecar.js';
import { nodeId } from './resolve.js';
import { computeDigraph } from '../_shared/digraph.js';

/**
 * Build the aggregate graph from per-post sidecars. Pure: nodes come from the
 * sidecars, edges from their `outgoing` lists. The degree/orphan math is the
 * reusable {@link computeDigraph} kernel; this function only maps sidecars onto
 * node records and the `graph.json` envelope. Titles are sourced live from
 * `titleById` (frontmatter, not stored in the sidecar) and fall back to the
 * slug when missing.
 */
export function buildGraph(
  sidecars: ReadonlyArray<PostSidecar>,
  titleById: ReadonlyMap<string, string>,
): GraphIndex {
  const nodes = new Map<string, GraphNode>();
  for (const sc of sidecars) {
    const id = nodeId(sc.type, sc.slug);
    nodes.set(id, {
      id,
      post_id: sc.post_id,
      type: sc.type,
      slug: sc.slug,
      title: titleById.get(id) ?? sc.slug,
      file_path: sc.file_path,
      in_degree: 0,
      out_degree: 0,
    });
  }

  const rawEdges = sidecars.flatMap((sc) => {
    const source = nodeId(sc.type, sc.slug);
    return sc.outgoing.map((o) => ({ source, target: nodeId(o.target_type, o.target_slug) }));
  });

  const stats = computeDigraph(nodes.keys(), rawEdges);
  for (const n of nodes.values()) {
    const d = stats.degreeById.get(n.id);
    if (d) {
      n.in_degree = d.in;
      n.out_degree = d.out;
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    last_run_completed: new Date().toISOString(),
    nodes: [...nodes.values()],
    edges: stats.edges,
    totals: {
      nodes: nodes.size,
      edges: stats.edges.length,
      orphans_no_in: stats.orphansNoIn,
      orphans_no_out: stats.orphansNoOut,
      isolated: stats.isolated,
    },
  };
}
