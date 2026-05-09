export interface OverviewResponse {
  contentDir: string;
  siteUrl: string;
  totals: { posts: number; pages: number; by_status: Record<string, number> };
  categories: { name: string; count: number }[];
  tags: { name: string; count: number }[];
  by_year: { year: number; count: number }[];
  recent_modified: {
    type: 'post' | 'page';
    slug: string;
    title: string;
    modified_gmt?: string;
  }[];
  orphan_pages: { slug: string; title: string; parent: number }[];
}

export interface AnalysisInfo {
  id: string;
  displayName: string;
  description: string;
  version: string;
  resultsView: string;
  lastRun?: {
    status: 'running' | 'finished' | 'cancelled' | 'error';
    startedAt: string;
    finishedAt?: string;
    eventCount: number;
    lastEvent?: { kind: string; message?: string; done?: number; total?: number; summary?: string };
  };
}

export type Verdict = 'OK' | 'SUSPICIOUS' | 'BROKEN';
export type ActionType = 'replace' | 'remove' | 'keep';
export type AttrQuote = '"' | "'" | '';
export type SuggestionConfidence = 'high' | 'medium' | 'low';
export type SuggestionState = 'accepted' | 'cleaned' | null;

export interface LinkSuggestion {
  url: string | null;
  confidence: SuggestionConfidence;
  note?: string;
  suggested_at: string;
  source: { provider: string; model: string };
  confirmed?: SuggestionState;
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
  last_check?: {
    checked_at: string;
    http_status?: number;
    final_url?: string;
    verdict: Verdict;
    reason_code: string;
    reason_detail?: string;
    cross_domain_redirect?: boolean;
  };
  action?: { type: ActionType; new_href: string | null; applied_at: string | null } | null;
  suggestion?: LinkSuggestion;
}

export interface FlatLink {
  postType: 'post' | 'page';
  postSlug: string;
  postTitle?: string;
  filePath: string;
  link: LinkRecord;
}

export interface ResultsResponse {
  index?: {
    schema_version: number;
    last_run_completed: string;
    posts_scanned: number;
    totals: { ok: number; suspicious: number; broken: number };
    posts_with_issues: { type: string; slug: string; broken: number; suspicious: number }[];
  };
  links: FlatLink[];
}

/* ─── Missing alt text ──────────────────────────────────────── */

export type DetectionRule = 'D1' | 'D2' | 'D3';
export type FindingStatus = 'open' | 'fixed';

export interface AltFinding {
  id: string;
  src: string;
  /** Undefined for findings preserved as 'fixed' rows after a successful apply. */
  rule?: DetectionRule;
  status: FindingStatus;
  tag_start: number;
  tag_end: number;
  alt_value_start: number;
  alt_value_end: number;
  alt_quote: AttrQuote;
  context_before: string;
  context_after: string;
  not_editable?: boolean;
  /** Last applied alt text. Pre-fills the edit form so users can re-edit. */
  applied_alt?: string;
  applied_at?: string;
}

export interface FlatAltFinding {
  postType: 'post' | 'page';
  postSlug: string;
  postTitle?: string;
  filePath: string;
  finding: AltFinding;
}

export interface MissingAltTextResults {
  index?: {
    schema_version: number;
    last_run_completed: string;
    posts_scanned: number;
    totals: { total_images: number; findings_open: number; findings_fixed: number };
    posts_with_issues: { type: string; slug: string; total_images: number; findings_open: number }[];
  };
  findings: FlatAltFinding[];
}

export interface SetAltEdit {
  postType: 'post' | 'page';
  slug: string;
  findingId: string;
  altText: string;
}

export interface SettingsResponse {
  root: string;
  activeSiteId?: string;
  contentDir: string;
  siteUrl: string;
  config: Record<string, unknown>;
  llmEnabled: boolean;
  llmDisabledReason?: string;
}

export interface LastAnalysis {
  finishedAt: string;
  headline: string;
}

export interface SiteSummary {
  id: string;
  label: string;
  relPath: string;
  addedAt: string;
  postCount?: number;
  lastAnalyses: Record<string, LastAnalysis>;
  isActive: boolean;
}

export interface SitesResponse {
  root: string;
  activeSiteId?: string;
  sites: SiteSummary[];
}

export interface SiteCandidate {
  relPath: string;
}

export interface ActionInfo {
  id: string;
  displayName: string;
  description: string;
  requiresLlm: boolean;
  inputSchema?: object;
  state?: {
    pluginId: string;
    actionName: string;
    status: 'running' | 'finished' | 'cancelled' | 'error';
    startedAt: string;
    finishedAt?: string;
  };
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  // Only declare a JSON content-type when we're actually sending a body —
  // Fastify rejects empty bodies that claim to be JSON.
  if (init?.body !== undefined && init?.body !== null && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { message?: string; error?: string };
      message = data.message ?? data.error ?? message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  overview: () => jsonFetch<OverviewResponse>('/api/overview'),
  analyses: () => jsonFetch<AnalysisInfo[]>('/api/analyses'),
  results: (id: string) => jsonFetch<ResultsResponse>(`/api/analyses/${id}/results`),
  startRun: (id: string, body: { fullRecheck?: boolean; reExtractAll?: boolean }) =>
    jsonFetch(`/api/analyses/${id}/run`, { method: 'POST', body: JSON.stringify(body) }),
  cancelRun: (id: string) =>
    jsonFetch<{ cancelled: boolean }>(`/api/analyses/${id}/cancel`, { method: 'POST' }),
  applyEdits: (
    id: string,
    edits: { postType: 'post' | 'page'; slug: string; linkId: string; action: ActionType; newHref?: string }[],
  ) =>
    jsonFetch<{ ok: boolean; message?: string; changedFiles?: string[] }>(
      `/api/analyses/${id}/apply`,
      { method: 'POST', body: JSON.stringify({ kind: 'edit', edits }) },
    ),
  cleanSuggestion: (
    id: string,
    target: { postType: 'post' | 'page'; slug: string; linkId: string },
  ) =>
    jsonFetch<{ ok: boolean; message?: string }>(`/api/analyses/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'clean-suggestion', ...target }),
    }),
  resetSuggestion: (
    id: string,
    target: { postType: 'post' | 'page'; slug: string; linkId: string },
  ) =>
    jsonFetch<{ ok: boolean; message?: string }>(`/api/analyses/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'reset-suggestion', ...target }),
    }),
  listActions: (id: string) => jsonFetch<ActionInfo[]>(`/api/analyses/${id}/actions`),
  startAction: (id: string, actionName: string, payload: unknown) =>
    jsonFetch(`/api/analyses/${id}/actions/${actionName}/start`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),
  cancelAction: (id: string, actionName: string) =>
    jsonFetch<{ cancelled: boolean }>(`/api/analyses/${id}/actions/${actionName}/cancel`, {
      method: 'POST',
    }),
  settings: () => jsonFetch<SettingsResponse>('/api/settings'),
  putSettings: (body: Record<string, unknown>) =>
    jsonFetch<{ ok: boolean; config: Record<string, unknown> }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  listSites: () => jsonFetch<SitesResponse>('/api/sites'),
  listSiteCandidates: () =>
    jsonFetch<{ candidates: SiteCandidate[] }>('/api/sites/candidates'),
  addSite: (body: { relPath: string; label?: string }) =>
    jsonFetch<{ ok: boolean; site: SiteSummary }>('/api/sites', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeSite: (id: string) =>
    jsonFetch<{ ok: boolean; activeSiteId?: string; sites: SiteSummary[] }>(
      `/api/sites/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  renameSite: (id: string, label: string) =>
    jsonFetch<{ ok: boolean; site: SiteSummary }>(
      `/api/sites/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify({ label }) },
    ),
  reorderSites: (ids: string[]) =>
    jsonFetch<{ ok: boolean; sites: SiteSummary[] }>('/api/sites/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    }),
  activateSite: (id: string) =>
    jsonFetch<{ ok: boolean; activeSiteId: string; contentDir: string; siteUrl: string }>(
      `/api/sites/${encodeURIComponent(id)}/activate`,
      { method: 'POST' },
    ),
  refreshSite: (id: string) =>
    jsonFetch<{ ok: boolean; site: SiteSummary }>(
      `/api/sites/${encodeURIComponent(id)}/refresh`,
      { method: 'POST' },
    ),
  altResults: () =>
    jsonFetch<MissingAltTextResults>('/api/analyses/missing-alt-text/results'),
  applySetAlt: (edits: SetAltEdit[]) =>
    jsonFetch<{ ok: boolean; message?: string; changedFiles?: string[] }>(
      '/api/analyses/missing-alt-text/apply',
      { method: 'POST', body: JSON.stringify({ kind: 'set-alt', edits }) },
    ),
};
