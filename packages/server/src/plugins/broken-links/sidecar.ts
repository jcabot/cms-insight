import type { PluginStorage, PostType } from '@cms-insight/plugin-api';
import type { AttrQuote } from '../../host/surgical-edit.js';
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

export type Verdict = 'OK' | 'SUSPICIOUS' | 'BROKEN';
export type ActionType = 'replace' | 'remove' | 'keep';
export type SuggestionConfidence = 'high' | 'medium' | 'low';
export type SuggestionState = 'accepted' | 'cleaned' | null;
export type { PostType };

export interface LinkSuggestion {
  url: string | null;
  confidence: SuggestionConfidence;
  note?: string;
  suggested_at: string;
  source: { provider: string; model: string };
  /** User state. null/undefined = unreviewed. */
  confirmed?: SuggestionState;
}

export interface LinkCheck {
  checked_at: string;
  http_status?: number;
  final_url?: string;
  verdict: Verdict;
  reason_code: string;
  reason_detail?: string;
  cross_domain_redirect?: boolean;
}

export interface LinkAction {
  type: ActionType;
  new_href: string | null;
  applied_at: string | null;
}

export interface LinkRecord {
  id: string;
  href: string;
  href_normalized: string;
  anchor_text: string;
  tag_start: number;
  tag_end: number;
  inner_start: number;
  inner_end: number;
  href_value_start: number;
  href_value_end: number;
  href_quote: AttrQuote;
  body_hash_at_extraction: string;
  not_editable?: boolean;
  last_check?: LinkCheck;
  action?: LinkAction | null;
  suggestion?: LinkSuggestion;
}

export interface PostSidecar extends BasePostSidecar {
  links: LinkRecord[];
}

export interface IndexFile {
  schema_version: number;
  last_run_completed: string;
  posts_scanned: number;
  totals: { ok: number; suspicious: number; broken: number };
  posts_with_issues: {
    type: PostType;
    slug: string;
    broken: number;
    suspicious: number;
  }[];
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

export function loadIndex(storage: PluginStorage): Promise<IndexFile | undefined> {
  return sharedLoadIndex<IndexFile>(storage, SCHEMA_VERSION);
}

export function saveIndex(storage: PluginStorage, index: IndexFile): Promise<void> {
  return sharedSaveIndex(storage, index);
}

export function listAllSidecars(storage: PluginStorage): AsyncIterable<PostSidecar> {
  return sharedListAllSidecars<PostSidecar>(storage, SCHEMA_VERSION);
}

export function buildIndex(sidecars: ReadonlyArray<PostSidecar>): IndexFile {
  let ok = 0;
  let suspicious = 0;
  let broken = 0;
  const issues: IndexFile['posts_with_issues'] = [];
  for (const sc of sidecars) {
    let pBroken = 0;
    let pSus = 0;
    for (const link of sc.links) {
      const v = link.last_check?.verdict;
      if (v === 'OK') ok++;
      else if (v === 'SUSPICIOUS') {
        suspicious++;
        pSus++;
      } else if (v === 'BROKEN') {
        broken++;
        pBroken++;
      }
    }
    if (pBroken + pSus > 0) {
      issues.push({ type: sc.type, slug: sc.slug, broken: pBroken, suspicious: pSus });
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    last_run_completed: new Date().toISOString(),
    posts_scanned: sidecars.length,
    totals: { ok, suspicious, broken },
    posts_with_issues: issues,
  };
}
