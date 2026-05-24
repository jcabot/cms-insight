import type { PluginStorage, PostType } from '@cms-insight/plugin-api';
import type { AttrQuote } from '../../host/surgical-edit.js';
import {
  type BasePostSidecar,
  sidecarKey,
  loadSidecar as sharedLoadSidecar,
  saveSidecar as sharedSaveSidecar,
  loadIndex as sharedLoadIndex,
  saveIndex as sharedSaveIndex,
  listAllSidecars as sharedListAllSidecars,
} from '../_shared/per-post-sidecar.js';

export { sidecarKey, pruneOrphanSidecars } from '../_shared/per-post-sidecar.js';

export const SCHEMA_VERSION = 1;

export type DetectionRule = 'D1' | 'D2' | 'D3';
export type FindingStatus = 'open' | 'fixed';
export type SuggestionConfidence = 'high' | 'medium' | 'low';
export type SuggestionState = 'accepted' | 'cleaned' | null;

export interface AltSuggestion {
  /** Suggested alt text. `null` when the model couldn't produce one (e.g. image unreachable). */
  text: string | null;
  confidence: SuggestionConfidence;
  /** Optional reasoning or caveat from the model. */
  note?: string;
  suggested_at: string;
  source: { provider: string; model: string };
  /** Tracks whether the user accepted/dismissed; reserved for future UI states. */
  confirmed?: SuggestionState;
}

export interface AltFinding {
  id: string;
  /** The img's `src` attribute (raw). */
  src: string;
  /** Current detection rule. Undefined when the img is not currently flagged but
   *  was previously fixed by the user (preserved as a re-editable row). */
  rule?: DetectionRule;
  status: FindingStatus;
  /** Byte offsets in the post body at extraction time. Stale on body change (gated by body_hash). */
  tag_start: number;
  tag_end: number;
  /** Offsets of the existing `alt` attribute value, when present. -1/-1 only when alt is absent (D1 untouched). */
  alt_value_start: number;
  alt_value_end: number;
  alt_quote: AttrQuote;
  /** Short snippet for UI context (text immediately before/after the tag). */
  context_before: string;
  context_after: string;
  /** True when offsets couldn't be derived; UI hides Apply for these. */
  not_editable?: boolean;
  /** The most recently applied alt text. Pre-fills the edit form so users can re-edit. */
  applied_alt?: string;
  /** ISO timestamp of the last successful apply. */
  applied_at?: string;
  /** LLM-generated suggestion the user can review and accept. */
  alt_suggestion?: AltSuggestion;
}

export interface PostSidecar extends BasePostSidecar {
  findings: AltFinding[];
}

export interface PostIssueSummary {
  type: PostType;
  slug: string;
  total_images: number;
  findings_open: number;
}

export interface IndexFile {
  schema_version: number;
  last_run_completed: string;
  posts_scanned: number;
  totals: {
    total_images: number;
    findings_open: number;
    findings_fixed: number;
  };
  posts_with_issues: PostIssueSummary[];
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

export function buildIndex(
  sidecars: ReadonlyArray<PostSidecar>,
  totalImagesByPost: ReadonlyMap<string, number>,
): IndexFile {
  let totalImages = 0;
  let findingsOpen = 0;
  let findingsFixed = 0;
  const issues: PostIssueSummary[] = [];
  for (const sc of sidecars) {
    const key = sidecarKey(sc.type, sc.slug);
    const total = totalImagesByPost.get(key) ?? sc.findings.length;
    totalImages += total;
    let open = 0;
    let fixed = 0;
    for (const f of sc.findings) {
      if (f.status === 'open') open++;
      else if (f.status === 'fixed') fixed++;
    }
    findingsOpen += open;
    findingsFixed += fixed;
    if (open > 0) {
      issues.push({ type: sc.type, slug: sc.slug, total_images: total, findings_open: open });
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    last_run_completed: new Date().toISOString(),
    posts_scanned: sidecars.length,
    totals: {
      total_images: totalImages,
      findings_open: findingsOpen,
      findings_fixed: findingsFixed,
    },
    posts_with_issues: issues,
  };
}
