import type { PluginStorage, PostType } from '@cms-insight/plugin-api';
import {
  type BasePostSidecar,
  loadSidecar as sharedLoadSidecar,
  saveSidecar as sharedSaveSidecar,
  loadIndex as sharedLoadIndex,
  saveIndex as sharedSaveIndex,
  listAllSidecars as sharedListAllSidecars,
} from '../_shared/per-post-sidecar.js';

export { sidecarKey, pruneOrphanSidecars } from '../_shared/per-post-sidecar.js';

export const SCHEMA_VERSION = 1;

/** One internal link target, deduplicated per ordered pair. Anchor texts are
 *  collected for display only — they carry no weight (an edge is boolean). */
export interface OutgoingLink {
  target_type: PostType;
  target_slug: string;
  anchors: string[];
}

export interface PostSidecar extends BasePostSidecar {
  outgoing: OutgoingLink[];
}

export interface GraphNode {
  /** `"<type>:<slug>"` — matches sidecarKey's type/slug pair. */
  id: string;
  /** WordPress numeric id, when known — a compact label for dense graphs. */
  post_id: number | undefined;
  type: PostType;
  slug: string;
  title: string;
  file_path: string;
  in_degree: number;
  out_degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphTotals {
  nodes: number;
  edges: number;
  orphans_no_in: number;
  orphans_no_out: number;
  isolated: number;
}

/** Aggregate `graph.json`, written once per run and consumed by the web view. */
export interface GraphIndex {
  schema_version: number;
  last_run_completed: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  totals: GraphTotals;
}

export function loadSidecar(
  storage: PluginStorage,
  type: PostType,
  slug: string,
): Promise<PostSidecar | undefined> {
  return sharedLoadSidecar<PostSidecar>(storage, type, slug, SCHEMA_VERSION);
}

export function saveSidecar(storage: PluginStorage, sidecar: PostSidecar): Promise<void> {
  return sharedSaveSidecar(storage, sidecar);
}

export function loadIndex(storage: PluginStorage): Promise<GraphIndex | undefined> {
  return sharedLoadIndex<GraphIndex>(storage, SCHEMA_VERSION);
}

export function saveIndex(storage: PluginStorage, index: GraphIndex): Promise<void> {
  return sharedSaveIndex(storage, index);
}

export function listAllSidecars(storage: PluginStorage): AsyncIterable<PostSidecar> {
  return sharedListAllSidecars<PostSidecar>(storage, SCHEMA_VERSION);
}
