export interface Degrees {
  in: number;
  out: number;
}

export interface DigraphStats {
  /** Input edges with both endpoints known, deduplicated per ordered pair. */
  edges: { source: string; target: string }[];
  degreeById: Map<string, Degrees>;
  orphansNoIn: number;
  orphansNoOut: number;
  isolated: number;
}

/**
 * Directed-graph math over opaque string node ids: deduplicate `(source,
 * target)` edges, count in/out degree per node, and derive orphan/isolated
 * totals. Edges whose endpoints are not in `nodeIds` are dropped. No
 * plugin-specific types — reusable by any analysis that builds a node-link
 * structure.
 */
export function computeDigraph(
  nodeIds: Iterable<string>,
  rawEdges: Iterable<{ source: string; target: string }>,
): DigraphStats {
  const degreeById = new Map<string, Degrees>();
  for (const id of nodeIds) degreeById.set(id, { in: 0, out: 0 });

  const edges: { source: string; target: string }[] = [];
  const seen = new Set<string>();
  for (const e of rawEdges) {
    const source = degreeById.get(e.source);
    const target = degreeById.get(e.target);
    if (!source || !target) continue; // endpoint not a known node — drop the edge
    const key = `${e.source} ${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: e.source, target: e.target });
    source.out++;
    target.in++;
  }

  let orphansNoIn = 0;
  let orphansNoOut = 0;
  let isolated = 0;
  for (const d of degreeById.values()) {
    if (d.in === 0) orphansNoIn++;
    if (d.out === 0) orphansNoOut++;
    if (d.in === 0 && d.out === 0) isolated++;
  }

  return { edges, degreeById, orphansNoIn, orphansNoOut, isolated };
}
