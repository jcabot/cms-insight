import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { api, type GraphEdge, type GraphNode } from '../api/client.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { subscribeSse } from '../api/sse.js';

const PLUGIN_ID = 'link-graph';
const SCALE_WARN_THRESHOLD = 1500;

type OrphanMode = 'off' | 'no-in' | 'no-out' | 'isolated';
type OrphanBehavior = 'highlight' | 'filter';
type NodeTypeFilter = 'both' | 'post' | 'page';
type ViewTab = 'graph' | 'list';
type SortKey = 'title' | 'type' | 'in' | 'out';
type LabelBy = 'name' | 'url' | 'id';

const ORPHAN_LABEL: Record<Exclude<OrphanMode, 'off'>, string> = {
  'no-in': 'with no incoming',
  'no-out': 'with no outgoing',
  isolated: 'isolated',
};

const DIM = 'rgba(120,130,150,0.18)';
const ISOLATED_COLOR = 'rgb(150,160,172)';

// Flow palette: colour encodes the in/out balance, not the node type (shape does
// that). Red = mostly outgoing (a source/hub that links out), green = mostly
// incoming (a sink that's linked to), orange = roughly balanced.
const FLOW_OUT: [number, number, number] = [214, 69, 69];
const FLOW_BAL: [number, number, number] = [232, 163, 58];
const FLOW_IN: [number, number, number] = [63, 166, 107];

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Map a node's in/out degree to a colour on the red→orange→green flow gradient. */
function flowColor(inDeg: number, outDeg: number): string {
  const total = inDeg + outDeg;
  if (total === 0) return ISOLATED_COLOR;
  const balance = (inDeg - outDeg) / total; // -1 = all outgoing, +1 = all incoming
  let from: [number, number, number];
  let to: [number, number, number];
  let t: number;
  if (balance < 0) {
    [from, to, t] = [FLOW_OUT, FLOW_BAL, balance + 1];
  } else {
    [from, to, t] = [FLOW_BAL, FLOW_IN, balance];
  }
  return `rgb(${lerp(from[0], to[0], t)},${lerp(from[1], to[1], t)},${lerp(from[2], to[2], t)})`;
}

interface RenderNode extends GraphNode {
  // react-force-graph mutates these in place during layout.
  x?: number;
  y?: number;
}

/**
 * Best-effort URL of the live post. Prefer the WordPress query-id form
 * (`?p=` / `?page_id=`) — WP redirects it to the canonical permalink regardless
 * of the site's permalink structure — and fall back to a slug path.
 */
function livePostUrl(siteUrl: string | undefined, n: GraphNode): string | undefined {
  if (!siteUrl) return undefined;
  const base = siteUrl.replace(/\/+$/, '');
  if (n.post_id != null) {
    return `${base}/?${n.type === 'page' ? 'page_id' : 'p'}=${n.post_id}`;
  }
  return `${base}/${n.slug}/`;
}

function matchesOrphan(n: GraphNode, mode: OrphanMode): boolean {
  switch (mode) {
    case 'no-in':
      return n.in_degree === 0;
    case 'no-out':
      return n.out_degree === 0;
    case 'isolated':
      return n.in_degree === 0 && n.out_degree === 0;
    default:
      return true;
  }
}

export function LinkGraphRun(): React.ReactElement {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['results', PLUGIN_ID],
    queryFn: () => api.linkGraphResults(),
  });
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings,
    staleTime: 60_000,
  });
  const siteUrl = settings?.siteUrl;

  const [progress, setProgress] = useState<{
    running: boolean;
    done?: number;
    total?: number;
    message?: string;
    finalSummary?: string;
  }>({ running: false });
  const sseUnsubRef = useRef<(() => void) | null>(null);

  const [view, setView] = useState<ViewTab>('graph');
  const [orphanMode, setOrphanMode] = useState<OrphanMode>('off');
  const [orphanBehavior, setOrphanBehavior] = useState<OrphanBehavior>('highlight');
  const [minIn, setMinIn] = useState(0);
  const [minOut, setMinOut] = useState(0);
  const [nodeType, setNodeType] = useState<NodeTypeFilter>('both');
  const [labelBy, setLabelBy] = useState<LabelBy>('name');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'in', dir: 'desc' });

  const startRun = useMutation({
    mutationFn: (opts: { reExtractAll?: boolean }) => api.startRun(PLUGIN_ID, opts),
    onSuccess: () => {
      sseUnsubRef.current?.();
      setProgress({ running: true });
      const unsub = subscribeSse(`/api/analyses/${PLUGIN_ID}/stream`, {
        onProgress: (ev) => {
          if (ev.kind === 'started') {
            setProgress({ running: true, message: 'Started' });
          } else if (ev.kind === 'progress') {
            setProgress({ running: true, done: ev.done, total: ev.total, message: ev.message });
          } else if (ev.kind === 'finished') {
            setProgress((p) => ({ ...p, running: false, finalSummary: ev.summary }));
            qc.invalidateQueries({ queryKey: ['results', PLUGIN_ID] });
            qc.invalidateQueries({ queryKey: ['sites'] });
          } else if (ev.kind === 'warn') {
            setProgress((p) => ({ ...p, message: `Warning: ${ev.message ?? ''}` }));
          }
        },
        onClosed: () => {
          setProgress((p) => ({ ...p, running: false }));
          qc.invalidateQueries({ queryKey: ['results', PLUGIN_ID] });
          qc.invalidateQueries({ queryKey: ['sites'] });
        },
      });
      sseUnsubRef.current = unsub;
    },
  });
  const cancelRun = useMutation({ mutationFn: () => api.cancelRun(PLUGIN_ID) });

  useEffect(() => () => sseUnsubRef.current?.(), []);

  const index = data?.index;
  const allNodes = useMemo(() => index?.nodes ?? [], [index]);
  const allEdges = useMemo(() => index?.edges ?? [], [index]);
  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);

  // Adjacency for hover highlighting and the side panel's neighbour lists.
  const neighbours = useMemo(() => {
    const out = new Map<string, { in: string[]; out: string[] }>();
    for (const n of allNodes) out.set(n.id, { in: [], out: [] });
    for (const e of allEdges) {
      out.get(e.source)?.out.push(e.target);
      out.get(e.target)?.in.push(e.source);
    }
    return out;
  }, [allNodes, allEdges]);

  // Directed edge keys, so reciprocal pairs (A→B and B→A) can be curved apart —
  // drawn straight they overlap and the two arrowheads become indistinguishable.
  const directedKeys = useMemo(
    () => new Set(allEdges.map((e) => `${e.source}>${e.target}`)),
    [allEdges],
  );

  const searchLc = search.trim().toLowerCase();

  // A node is "included" when it passes the hard filters (type + degree sliders).
  const includedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const n of allNodes) {
      if (nodeType !== 'both' && n.type !== nodeType) continue;
      if (n.in_degree < minIn) continue;
      if (n.out_degree < minOut) continue;
      ids.add(n.id);
    }
    return ids;
  }, [allNodes, nodeType, minIn, minOut]);

  // Among included nodes, "matched" ones satisfy the orphan filter.
  const matchedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const n of allNodes) {
      if (!includedIds.has(n.id)) continue;
      if (matchesOrphan(n, orphanMode)) ids.add(n.id);
    }
    return ids;
  }, [allNodes, includedIds, orphanMode]);

  // "Filter out" removes the matched nodes (e.g. the no-incoming orphans), keeping
  // the rest and the edges between them. "Highlight" keeps everything and only dims
  // the non-matches. (Keeping *only* the matches would strand them: a no-incoming
  // node's edges all point at nodes that have incoming links, so they'd be hidden.)
  const visibleIds = useMemo(() => {
    if (orphanBehavior === 'filter' && orphanMode !== 'off') {
      const out = new Set<string>();
      for (const id of includedIds) if (!matchedIds.has(id)) out.add(id);
      return out;
    }
    return includedIds;
  }, [orphanBehavior, orphanMode, matchedIds, includedIds]);

  const graphData = useMemo(() => {
    const nodes: RenderNode[] = allNodes.filter((n) => visibleIds.has(n.id)).map((n) => ({ ...n }));
    const present = new Set(nodes.map((n) => n.id));
    const links: GraphEdge[] = allEdges
      .filter((e) => present.has(e.source) && present.has(e.target))
      .map((e) => ({ ...e }));
    return { nodes, links };
  }, [allNodes, allEdges, visibleIds]);

  const visibleList = useMemo(() => {
    let rows = allNodes.filter((n) => visibleIds.has(n.id));
    if (searchLc) rows = rows.filter((n) => n.title.toLowerCase().includes(searchLc));
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (sort.key) {
        case 'title':
          return a.title.localeCompare(b.title) * dir;
        case 'type':
          return a.type.localeCompare(b.type) * dir;
        case 'in':
          return (a.in_degree - b.in_degree) * dir;
        case 'out':
          return (a.out_degree - b.out_degree) * dir;
      }
    });
  }, [allNodes, visibleIds, searchLc, sort]);

  // Hover dims everything except the node and its direct neighbours.
  const hoverSet = useMemo(() => {
    if (!hoverId) return null;
    const nb = neighbours.get(hoverId);
    const s = new Set<string>([hoverId]);
    nb?.in.forEach((x) => s.add(x));
    nb?.out.forEach((x) => s.add(x));
    return s;
  }, [hoverId, neighbours]);

  // "Base" activeness from the dimming filters (search + orphan highlight). A node
  // these dim must stay dim even when hovered — hover only narrows focus, it never
  // promotes a filtered-out node to the active colour.
  const baseActive = useCallback(
    (id: string): boolean => {
      if (searchLc) {
        const n = nodeById.get(id);
        if (n && !n.title.toLowerCase().includes(searchLc)) return false;
      }
      if (orphanBehavior === 'highlight' && orphanMode !== 'off') return matchedIds.has(id);
      return true;
    },
    [searchLc, nodeById, orphanBehavior, orphanMode, matchedIds],
  );

  const isActive = useCallback(
    (id: string): boolean => {
      if (!baseActive(id)) return false;
      return hoverSet ? hoverSet.has(id) : true;
    },
    [baseActive, hoverSet],
  );

  const edgeActive = useCallback(
    (l: { source: unknown; target: unknown }): boolean => {
      const s = typeof l.source === 'object' && l.source ? (l.source as RenderNode).id : (l.source as string);
      const t = typeof l.target === 'object' && l.target ? (l.target as RenderNode).id : (l.target as string);
      return isActive(s) && isActive(t);
    },
    [isActive],
  );

  // "Interesting" nodes — the hubs — get a label by default and a ring, so the
  // important parts of the graph are legible without zooming or hovering.
  const hubThreshold = useMemo(() => {
    let max = 0;
    for (const n of graphData.nodes) max = Math.max(max, n.in_degree + n.out_degree);
    return Math.max(2, Math.ceil(max * 0.6));
  }, [graphData]);

  const labelText = useCallback(
    (n: RenderNode): string => {
      switch (labelBy) {
        case 'url':
          return `/${n.slug}/`;
        case 'id':
          return n.post_id != null ? `#${n.post_id}` : n.slug;
        default:
          return n.title;
      }
    },
    [labelBy],
  );

  // On first load of a large graph, default to compact numeric ids; the user can
  // still switch back. A ref keeps this a one-shot so refetches don't override.
  const autoLabelDone = useRef(false);
  useEffect(() => {
    if (autoLabelDone.current || !index) return;
    autoLabelDone.current = true;
    if (index.totals.nodes > 300) setLabelBy('id');
  }, [index]);

  const fgRef = useRef<ForceGraphMethods<RenderNode, GraphEdge> | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 560 });
  // Depend on `index` too: the canvas only mounts once results exist, so the
  // observer must (re)attach when data arrives — not just on a view switch.
  // Without this the graph stays unsized until a remount (site switch / first run).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = (): void => setDims({ w: el.clientWidth, h: Math.max(420, el.clientHeight) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view, index]);

  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const selectedNb = selectedId ? neighbours.get(selectedId) : undefined;

  if (isLoading) return <p className="loading">Loading results…</p>;
  if (error) return <p className="error-line">{(error as Error).message}</p>;

  const totals = index?.totals;
  const hasRun = !!index;
  const visibleCount = visibleIds.size;
  const matchedCount = matchedIds.size;

  return (
    <article>
      <header className="page-header">
        <div className="title">
          <span className="eyebrow">Analyses · Internal link graph</span>
          <h1>Internal link graph</h1>
          <p className="muted">
            Every internal <code className="mono">&lt;a&gt;</code> between published posts and pages,
            drawn as a directed graph. Find orphans nothing links to and hubs that link everywhere.
          </p>
        </div>
        <div className="actions">
          <button
            disabled={progress.running || startRun.isPending}
            onClick={() => startRun.mutate({ reExtractAll: true })}
            title="Re-parse every post body, ignoring the body-hash cache"
          >
            Re-extract all
          </button>
          <button
            className="primary"
            disabled={progress.running || startRun.isPending}
            onClick={() => startRun.mutate({})}
            title="Re-parse only changed bodies, then rebuild the graph"
          >
            {hasRun ? 'Rescan' : 'Run'}
          </button>
          {progress.running && <button onClick={() => cancelRun.mutate()}>Cancel</button>}
        </div>
      </header>

      <section className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Nodes</div>
          <div className="kpi-value">{totals?.nodes ?? 0}</div>
          <div className="kpi-sub">posts + pages</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Internal links</div>
          <div className="kpi-value">{totals?.edges ?? 0}</div>
          <div className="kpi-sub">directed edges</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Orphans</div>
          <div className="kpi-value broken">{totals?.orphans_no_in ?? 0}</div>
          <div className="kpi-sub">nothing links in</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Isolated</div>
          <div className="kpi-value suspicious">{totals?.isolated ?? 0}</div>
          <div className="kpi-sub">no links either way</div>
        </div>
      </section>

      <section className={`toolbar ${progress.running ? 'progress-running' : ''}`}>
        <ProgressBar done={progress.done} total={progress.total} running={progress.running} />
        {(progress.message || progress.finalSummary) && (
          <div className="toolbar-line">
            {progress.message && <span className="status-line">{progress.message}</span>}
            {progress.finalSummary && <span className="summary">— {progress.finalSummary}</span>}
          </div>
        )}
      </section>

      {!hasRun ? (
        <div className="empty">
          <div className="icon">⋔</div>
          <h3>No graph yet</h3>
          <p>Run the analysis to map internal links between your published posts and pages.</p>
        </div>
      ) : (
        <>
          {totals && totals.nodes > SCALE_WARN_THRESHOLD && (
            <p className="warn-line">
              {totals.nodes.toLocaleString()} nodes — the canvas may feel sluggish. Use the degree
              sliders or the list view to narrow things down.
            </p>
          )}

          <section className="lg-controls">
            <div className="lg-field">
              <label>Orphans</label>
              <select value={orphanMode} onChange={(e) => setOrphanMode(e.target.value as OrphanMode)}>
                <option value="off">Off</option>
                <option value="no-in">No incoming</option>
                <option value="no-out">No outgoing</option>
                <option value="isolated">Fully isolated</option>
              </select>
              <div className="lg-seg" role="group" aria-label="orphan display">
                <button
                  className={orphanBehavior === 'highlight' ? 'active' : ''}
                  disabled={orphanMode === 'off'}
                  onClick={() => setOrphanBehavior('highlight')}
                >
                  Highlight
                </button>
                <button
                  className={orphanBehavior === 'filter' ? 'active' : ''}
                  disabled={orphanMode === 'off'}
                  onClick={() => setOrphanBehavior('filter')}
                >
                  Filter out
                </button>
              </div>
            </div>

            <div className="lg-field">
              <label>Min incoming: {minIn}</label>
              <input type="range" min={0} max={10} value={minIn} onChange={(e) => setMinIn(+e.target.value)} />
            </div>
            <div className="lg-field">
              <label>Min outgoing: {minOut}</label>
              <input type="range" min={0} max={10} value={minOut} onChange={(e) => setMinOut(+e.target.value)} />
            </div>

            <div className="lg-field">
              <label>Node type</label>
              <select value={nodeType} onChange={(e) => setNodeType(e.target.value as NodeTypeFilter)}>
                <option value="both">Posts &amp; pages</option>
                <option value="post">Posts only</option>
                <option value="page">Pages only</option>
              </select>
            </div>

            <div className="lg-field">
              <label>Label by</label>
              <select value={labelBy} onChange={(e) => setLabelBy(e.target.value as LabelBy)}>
                <option value="name">Name</option>
                <option value="url">URL (slug)</option>
                <option value="id">ID</option>
              </select>
            </div>

            <div className="lg-field lg-grow">
              <label>Find a node</label>
              <input
                type="search"
                placeholder="Search by title…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="lg-readout">
              {orphanMode === 'off'
                ? `${visibleCount} of ${totals?.nodes ?? 0} nodes`
                : orphanBehavior === 'filter'
                  ? `${matchedCount} ${ORPHAN_LABEL[orphanMode]} hidden · ${visibleCount} of ${totals?.nodes ?? 0} shown`
                  : `${matchedCount} ${ORPHAN_LABEL[orphanMode]} highlighted of ${totals?.nodes ?? 0}`}
            </div>

            <div className="lg-seg lg-tabs" role="tablist" aria-label="view">
              <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>
                Graph
              </button>
              <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
                List
              </button>
            </div>
          </section>

          {view === 'graph' ? (
            <section className="lg-split">
              <div className="lg-canvas" ref={wrapRef}>
                <ForceGraph2D
                  key={`${settings?.activeSiteId ?? ''}:${index?.last_run_completed ?? ''}`}
                  ref={fgRef}
                  width={dims.w}
                  height={dims.h}
                  graphData={graphData}
                  cooldownTicks={120}
                  nodeRelSize={4}
                  linkWidth={(l) => (edgeActive(l) ? 1.6 : 0.6)}
                  linkColor={(l) => (edgeActive(l) ? 'rgba(90,101,115,0.55)' : DIM)}
                  linkDirectionalArrowLength={(l) => (edgeActive(l) ? 9 : 5)}
                  linkDirectionalArrowRelPos={0.96}
                  linkDirectionalArrowColor={(l) => (edgeActive(l) ? 'rgba(50,60,75,0.9)' : DIM)}
                  linkCurvature={(l) => {
                    const s = typeof l.source === 'object' && l.source ? (l.source as RenderNode).id : (l.source as string);
                    const t = typeof l.target === 'object' && l.target ? (l.target as RenderNode).id : (l.target as string);
                    return directedKeys.has(`${t}>${s}`) ? 0.25 : 0;
                  }}
                  onNodeHover={(n) => setHoverId(n ? (n as RenderNode).id : null)}
                  onNodeClick={(n) => setSelectedId((n as RenderNode).id)}
                  onBackgroundClick={() => setSelectedId(null)}
                  nodeCanvasObject={(node, ctx, scale) => {
                    const n = node as RenderNode;
                    const deg = n.in_degree + n.out_degree;
                    const r = 3 + Math.sqrt(deg) * 2.3;
                    const active = isActive(n.id);
                    const isHub = deg >= hubThreshold;
                    const focused = n.id === selectedId || n.id === hoverId;
                    const base = flowColor(n.in_degree, n.out_degree);
                    const x = n.x ?? 0;
                    const y = n.y ?? 0;
                    ctx.fillStyle = active ? base : DIM;
                    if (n.type === 'page') {
                      ctx.fillRect(x - r, y - r, r * 2, r * 2);
                    } else {
                      ctx.beginPath();
                      ctx.arc(x, y, r, 0, 2 * Math.PI);
                      ctx.fill();
                    }
                    // Ring hubs (and the selected node) so importance reads at a glance.
                    if (n.id === selectedId || (isHub && active)) {
                      ctx.strokeStyle = n.id === selectedId ? '#0F766E' : 'rgba(15,20,25,0.35)';
                      ctx.lineWidth = (n.id === selectedId ? 2 : 1.25) / scale;
                      ctx.beginPath();
                      ctx.arc(x, y, r + 1.5, 0, 2 * Math.PI);
                      ctx.stroke();
                    }
                    // Label the interesting nodes by default; reveal the full name on
                    // hover/selection even in compact (url/id) modes.
                    if (active && (scale > 2.2 || isHub || focused)) {
                      const text = focused ? n.title : labelText(n);
                      ctx.font = `${(focused || isHub ? 11 : 10) / scale}px sans-serif`;
                      ctx.fillStyle = 'rgba(15,20,25,0.82)';
                      ctx.textAlign = 'center';
                      ctx.fillText(text, x, y + r + 9 / scale);
                    }
                  }}
                  nodePointerAreaPaint={(node, color, ctx) => {
                    const n = node as RenderNode;
                    const deg = n.in_degree + n.out_degree;
                    const r = 3 + Math.sqrt(deg) * 1.6;
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(n.x ?? 0, n.y ?? 0, r + 2, 0, 2 * Math.PI);
                    ctx.fill();
                  }}
                />
                <div className="lg-legend">
                  <span><i className="dot lg-post" /> post</span>
                  <span><i className="dot lg-page" /> page</span>
                  <i className="lg-sep" />
                  <span><i className="dot lg-out" /> outgoing</span>
                  <span><i className="dot lg-bal" /> balanced</span>
                  <span><i className="dot lg-in" /> incoming</span>
                  <button onClick={() => fgRef.current?.zoomToFit(400, 40)}>Fit</button>
                </div>
              </div>

              <aside className="lg-panel">
                {selected ? (
                  <>
                    <h3>{selected.title}</h3>
                    <dl>
                      <dt>Type</dt><dd>{selected.type}</dd>
                      <dt>Slug</dt>
                      <dd className="mono">
                        {livePostUrl(siteUrl, selected) ? (
                          <a
                            href={livePostUrl(siteUrl, selected)}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="lg-postlink"
                            title="Open the live post in a new tab"
                          >
                            {selected.slug} ↗
                          </a>
                        ) : (
                          selected.slug
                        )}
                      </dd>
                      <dt>File</dt><dd className="mono">{selected.file_path}</dd>
                      <dt>Incoming</dt><dd>{selected.in_degree}</dd>
                      <dt>Outgoing</dt><dd>{selected.out_degree}</dd>
                    </dl>
                    <h4>Links out ({selectedNb?.out.length ?? 0})</h4>
                    <ul className="lg-neighbours">
                      {(selectedNb?.out ?? []).map((id) => (
                        <li key={id}>
                          <button onClick={() => setSelectedId(id)}>{nodeById.get(id)?.title ?? id}</button>
                        </li>
                      ))}
                      {(selectedNb?.out.length ?? 0) === 0 && <li className="muted">— none</li>}
                    </ul>
                    <h4>Linked from ({selectedNb?.in.length ?? 0})</h4>
                    <ul className="lg-neighbours">
                      {(selectedNb?.in ?? []).map((id) => (
                        <li key={id}>
                          <button onClick={() => setSelectedId(id)}>{nodeById.get(id)?.title ?? id}</button>
                        </li>
                      ))}
                      {(selectedNb?.in.length ?? 0) === 0 && <li className="muted">— none (orphan)</li>}
                    </ul>
                  </>
                ) : (
                  <p className="muted">Click a node to inspect its links, or hover to highlight its neighbours.</p>
                )}
              </aside>
            </section>
          ) : (
            <section className="lg-list">
              <table>
                <thead>
                  <tr>
                    {([
                      ['title', 'Title'],
                      ['type', 'Type'],
                      ['in', 'In'],
                      ['out', 'Out'],
                    ] as [SortKey, string][]).map(([key, label]) => (
                      <th
                        key={key}
                        className={`sortable ${sort.key === key ? sort.dir : ''}`}
                        onClick={() =>
                          setSort((s) =>
                            s.key === key
                              ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
                              : { key, dir: key === 'title' || key === 'type' ? 'asc' : 'desc' },
                          )
                        }
                      >
                        {label}
                      </th>
                    ))}
                    <th>Slug</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleList.map((n) => (
                    <tr
                      key={n.id}
                      className={selectedId === n.id ? 'selected' : ''}
                      onClick={() => {
                        setSelectedId(n.id);
                        setView('graph');
                      }}
                    >
                      <td>{n.title}</td>
                      <td>{n.type}</td>
                      <td>{n.in_degree}</td>
                      <td>{n.out_degree}</td>
                      <td className="mono">{n.slug}</td>
                    </tr>
                  ))}
                  {visibleList.length === 0 && (
                    <tr><td colSpan={5} className="muted">No nodes match the current filters.</td></tr>
                  )}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </article>
  );
}
