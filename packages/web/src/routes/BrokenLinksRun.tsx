import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type ActionType,
  type FlatLink,
  type LinkSuggestion,
  type Verdict,
} from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { formatReason } from '../components/ReasonText.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { SuggestionLine } from '../components/SuggestionLine.js';
import { subscribeSse } from '../api/sse.js';

type FilterStatus = 'ALL' | 'BROKEN' | 'SUSPICIOUS' | 'OK' | 'UNREVIEWED';
type SortKey = 'status' | 'post' | 'link' | 'reason';
type SortDir = 'asc' | 'desc';
const VERDICT_RANK: Record<string, number> = { OK: 1, SUSPICIOUS: 2, BROKEN: 3 };

interface DraftEdit {
  action: ActionType;
  newHref?: string;
}

function isEmptyReplaceDraft(d: DraftEdit | undefined): boolean {
  return !!d && d.action === 'replace' && (d.newHref ?? '').trim() === '';
}

function isMeaningfulDraft(d: DraftEdit | undefined): boolean {
  return !!d && !isEmptyReplaceDraft(d);
}

function postUrl(siteUrl: string | undefined, slug: string): string | undefined {
  if (!siteUrl) return undefined;
  return `${siteUrl.replace(/\/+$/, '')}/${slug}/`;
}

const PLUGIN_ID = 'broken-links';

export function BrokenLinksRun(): React.ReactElement {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['results', PLUGIN_ID],
    queryFn: () => api.results(PLUGIN_ID),
  });
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings,
    staleTime: 60_000,
  });
  const siteUrl = settings?.siteUrl;

  const [filter, setFilter] = useState<FilterStatus>('ALL');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, DraftEdit>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    running: boolean;
    done?: number;
    total?: number;
    message?: string;
    finalSummary?: string;
  }>({ running: false });
  const [suggestProgress, setSuggestProgress] = useState<{
    running: boolean;
    done?: number;
    total?: number;
    message?: string;
    finalSummary?: string;
  }>({ running: false });
  const sseUnsubRef = useRef<(() => void) | null>(null);
  const suggestSseUnsubRef = useRef<(() => void) | null>(null);

  const setDraftForKey = useCallback((key: string, d: DraftEdit | undefined): void => {
    setDrafts((prev) => {
      if (!d) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: d };
    });
  }, []);

  const onToggleRow = useCallback((rowKey: string) => {
    setExpanded((prev) => {
      const next = prev === rowKey ? null : rowKey;
      setDrafts((d) => {
        let result = d;
        if (prev !== null && prev !== next) {
          const old = result[prev];
          if (isEmptyReplaceDraft(old)) {
            result = { ...result };
            delete result[prev];
          }
        }
        if (prev === next && next !== null) {
          const cur = result[next];
          if (isEmptyReplaceDraft(cur)) {
            result = { ...result };
            delete result[next];
          }
        }
        if (next !== null && !(next in result)) {
          result = { ...result, [next]: { action: 'replace', newHref: '' } };
        }
        return result;
      });
      return next;
    });
  }, []);

  const startRun = useMutation({
    mutationFn: (opts: { fullRecheck?: boolean; reExtractAll?: boolean }) =>
      api.startRun(PLUGIN_ID, opts),
    onSuccess: () => {
      sseUnsubRef.current?.();
      setProgress({ running: true });
      const unsub = subscribeSse(`/api/analyses/${PLUGIN_ID}/stream`, {
        onProgress: (ev) => {
          if (ev.kind === 'started') {
            setProgress({ running: true, message: 'Started' });
          } else if (ev.kind === 'progress') {
            setProgress({
              running: true,
              done: ev.done,
              total: ev.total,
              message: ev.message,
            });
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

  const startSuggest = useMutation({
    mutationFn: (opts: { force?: boolean }) =>
      api.startAction(PLUGIN_ID, 'suggest-replacements', opts),
    onSuccess: () => {
      suggestSseUnsubRef.current?.();
      setSuggestProgress({ running: true, message: 'Starting suggestion run…' });
      const unsub = subscribeSse(
        `/api/analyses/${PLUGIN_ID}/actions/suggest-replacements/stream`,
        {
          onProgress: (ev) => {
            if (ev.kind === 'started') {
              setSuggestProgress({ running: true, message: 'Started' });
            } else if (ev.kind === 'progress') {
              setSuggestProgress({
                running: true,
                done: ev.done,
                total: ev.total,
                message: ev.message,
              });
            } else if (ev.kind === 'finished') {
              setSuggestProgress((p) => ({
                ...p,
                running: false,
                finalSummary: ev.summary,
              }));
              qc.invalidateQueries({ queryKey: ['results', PLUGIN_ID] });
            } else if (ev.kind === 'warn') {
              setSuggestProgress((p) => ({
                ...p,
                message: `Warning: ${ev.message ?? ''}`,
              }));
            }
          },
          onClosed: () => {
            setSuggestProgress((p) => ({ ...p, running: false }));
            qc.invalidateQueries({ queryKey: ['results', PLUGIN_ID] });
          },
        },
      );
      suggestSseUnsubRef.current = unsub;
    },
  });
  const cancelSuggest = useMutation({
    mutationFn: () => api.cancelAction(PLUGIN_ID, 'suggest-replacements'),
  });

  const cleanSuggestion = useMutation({
    mutationFn: (target: { postType: 'post' | 'page'; slug: string; linkId: string }) =>
      api.cleanSuggestion(PLUGIN_ID, target),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['results', PLUGIN_ID] }),
  });

  const apply = useMutation({
    mutationFn: () => {
      const edits = Object.entries(drafts)
        .filter(([, v]) => isMeaningfulDraft(v))
        .map(([k, v]) => {
          const [postType, slug, linkId] = decodeKey(k);
          return {
            postType: postType as 'post' | 'page',
            slug,
            linkId,
            action: v.action,
            newHref: v.action === 'replace' ? v.newHref : undefined,
          };
        });
      return api.applyEdits(PLUGIN_ID, edits);
    },
    onSuccess: () => {
      setDrafts({});
      qc.invalidateQueries({ queryKey: ['results', PLUGIN_ID] });
    },
  });

  // Keep doesn't touch the file — committing immediately matches the user's intent
  // ("clicking Keep is my way of saying I've reviewed this") and avoids the Apply-all step.
  const keepLink = useMutation({
    mutationFn: (target: { postType: 'post' | 'page'; slug: string; linkId: string }) =>
      api.applyEdits(PLUGIN_ID, [{ ...target, action: 'keep' }]),
    onSuccess: (_, target) => {
      const key = encodeKey(target.postType, target.slug, target.linkId);
      setDraftForKey(key, undefined);
      setExpanded((prev) => (prev === key ? null : prev));
      qc.invalidateQueries({ queryKey: ['results', PLUGIN_ID] });
    },
  });

  useEffect(
    () => () => {
      sseUnsubRef.current?.();
      suggestSseUnsubRef.current?.();
    },
    [],
  );

  const allLinks = data?.links ?? [];
  const counts = useMemo(() => {
    let broken = 0,
      suspicious = 0,
      ok = 0,
      unreviewed = 0;
    for (const r of allLinks) {
      const v = r.link.last_check?.verdict;
      if (v === 'BROKEN') broken++;
      else if (v === 'SUSPICIOUS') suspicious++;
      else if (v === 'OK') ok++;
      if (!r.link.action) unreviewed++;
    }
    return { broken, suspicious, ok, unreviewed, total: allLinks.length };
  }, [allLinks]);

  const filtered = useMemo<FlatLink[]>(() => {
    return allLinks.filter((row) => {
      const v = row.link.last_check?.verdict;
      if (filter === 'BROKEN' && v !== 'BROKEN') return false;
      if (filter === 'SUSPICIOUS' && v !== 'SUSPICIOUS') return false;
      if (filter === 'OK' && v !== 'OK') return false;
      if (filter === 'UNREVIEWED' && row.link.action) return false;
      if (filter === 'ALL' && v === 'OK') return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !row.link.href.toLowerCase().includes(q) &&
          !row.postSlug.toLowerCase().includes(q) &&
          !row.link.anchor_text.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [allLinks, filter, search]);

  const sortedRows = useMemo<FlatLink[]>(() => {
    if (!sort) return filtered;
    const m = sort.dir === 'asc' ? 1 : -1;
    return filtered.slice().sort((a, b) => {
      switch (sort.key) {
        case 'status': {
          const aR = VERDICT_RANK[a.link.last_check?.verdict ?? ''] ?? 0;
          const bR = VERDICT_RANK[b.link.last_check?.verdict ?? ''] ?? 0;
          return (aR - bR) * m;
        }
        case 'post':
          return `${a.postType}/${a.postSlug}`.localeCompare(`${b.postType}/${b.postSlug}`) * m;
        case 'link':
          return a.link.href.localeCompare(b.link.href) * m;
        case 'reason': {
          const aC = a.link.last_check?.reason_code ?? '';
          const bC = b.link.last_check?.reason_code ?? '';
          return aC.localeCompare(bC) * m;
        }
      }
    });
  }, [filtered, sort]);

  const cycleSort = useCallback((key: SortKey): void => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
  }, []);

  if (isLoading) return <p className="loading">Loading results…</p>;
  if (error) return <p className="error-line">{(error as Error).message}</p>;

  const totals = data?.index?.totals;
  const draftCount = Object.values(drafts).filter(isMeaningfulDraft).length;
  const lastRunAt = data?.index?.last_run_completed;

  return (
    <article>
      <header className="page-header">
        <div className="title">
          <span className="eyebrow">Analyses · Broken links</span>
          <h1>External link survey</h1>
          <p className="muted">
            Every external <code className="mono">&lt;a&gt;</code> is fetched, classified, and either
            replaced, removed, or kept. Edits are surgical — attribute order and quoting survive.
          </p>
        </div>
        <div className="actions">
          <button
            disabled={progress.running || startRun.isPending}
            onClick={() => startRun.mutate({ fullRecheck: true, reExtractAll: true })}
            title="Re-parse every post body AND re-check every link, ignoring all caches"
          >
            Re-extract all
          </button>
          <button
            disabled={progress.running || startRun.isPending}
            onClick={() => startRun.mutate({ fullRecheck: true })}
            title="Re-check every link regardless of TTL (bodies still parsed only when changed)"
          >
            Full check
          </button>
          <button
            disabled={
              !settings?.llmEnabled ||
              suggestProgress.running ||
              startSuggest.isPending ||
              (counts.broken === 0)
            }
            title={
              !settings?.llmEnabled
                ? settings?.llmDisabledReason
                  ? `LLM disabled: ${settings.llmDisabledReason}`
                  : 'Set ANTHROPIC_API_KEY to enable AI suggestions'
                : counts.broken === 0
                  ? 'No broken links to suggest replacements for'
                  : ''
            }
            onClick={() => startSuggest.mutate({})}
          >
            ✨ Suggest replacements
          </button>
          <button
            className="primary"
            disabled={progress.running || startRun.isPending}
            onClick={() => startRun.mutate({})}
            title="Re-parse only changed bodies and re-check only links whose TTL is due"
          >
            Check new
          </button>
          {progress.running && <button onClick={() => cancelRun.mutate()}>Cancel</button>}
          {suggestProgress.running && (
            <button onClick={() => cancelSuggest.mutate()}>Cancel suggest</button>
          )}
        </div>
      </header>

      <section className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Total checked</div>
          <div className="kpi-value">{totals ? totals.broken + totals.suspicious + totals.ok : 0}</div>
          <div className="kpi-sub">{counts.total} extracted links</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Broken</div>
          <div className="kpi-value broken">{totals?.broken ?? 0}</div>
          <div className="kpi-sub">
            <span className="swatch" style={{ background: 'var(--broken)' }} /> requires action
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Suspicious</div>
          <div className="kpi-value suspicious">{totals?.suspicious ?? 0}</div>
          <div className="kpi-sub">
            <span className="swatch" style={{ background: 'var(--suspicious)' }} /> review
            recommended
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">OK</div>
          <div className="kpi-value ok">{totals?.ok ?? 0}</div>
          <div className="kpi-sub">
            <span className="swatch" style={{ background: 'var(--ok)' }} /> healthy
          </div>
        </div>
      </section>

      <section className={`toolbar ${progress.running ? 'progress-running' : ''}`}>
        <div className="toolbar-line">
          <div className="chips" role="tablist" aria-label="filter">
            <span
              role="tab"
              className={`chip ${filter === 'ALL' ? 'active' : ''}`}
              onClick={() => setFilter('ALL')}
            >
              Issues <span className="pin">{counts.broken + counts.suspicious}</span>
            </span>
            <span
              role="tab"
              className={`chip ${filter === 'BROKEN' ? 'active' : ''}`}
              onClick={() => setFilter('BROKEN')}
            >
              Broken <span className="pin">{counts.broken}</span>
            </span>
            <span
              role="tab"
              className={`chip ${filter === 'SUSPICIOUS' ? 'active' : ''}`}
              onClick={() => setFilter('SUSPICIOUS')}
            >
              Suspicious <span className="pin">{counts.suspicious}</span>
            </span>
            <span
              role="tab"
              className={`chip ${filter === 'OK' ? 'active' : ''}`}
              onClick={() => setFilter('OK')}
            >
              OK <span className="pin">{counts.ok}</span>
            </span>
            <span
              role="tab"
              className={`chip ${filter === 'UNREVIEWED' ? 'active' : ''}`}
              onClick={() => setFilter('UNREVIEWED')}
            >
              Unreviewed <span className="pin">{counts.unreviewed}</span>
            </span>
          </div>
          <div className="spacer" />
          <input
            type="text"
            placeholder="Search href, slug, or anchor text…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 320 }}
          />
        </div>
        <ProgressBar done={progress.done} total={progress.total} running={progress.running} />
        <div className="toolbar-line">
          {progress.message ? (
            <span className="status-line">{progress.message}</span>
          ) : (
            <span className="status-line muted">
              {lastRunAt
                ? `Last completed ${lastRunAt.replace('T', ' ').slice(0, 16)}`
                : 'No run yet — click Check new to populate.'}
            </span>
          )}
          {progress.finalSummary && <span className="summary">— {progress.finalSummary}</span>}
        </div>
        {(suggestProgress.running || suggestProgress.message || suggestProgress.finalSummary) && (
          <>
            <ProgressBar
              done={suggestProgress.done}
              total={suggestProgress.total}
              running={suggestProgress.running}
            />
            <div className="toolbar-line">
              <span className="status-line">
                <span style={{ marginRight: 6 }}>✨</span>
                {suggestProgress.message ?? 'Suggestion run idle'}
              </span>
              {suggestProgress.finalSummary && (
                <span className="summary">— {suggestProgress.finalSummary}</span>
              )}
            </div>
          </>
        )}
      </section>

      {draftCount > 0 && (
        <div className="queued-banner">
          <span className="label">
            <span className="n">{draftCount}</span>
            edit{draftCount === 1 ? '' : 's'} pending
          </span>
          <div className="spacer" />
          <button onClick={() => setDrafts({})}>Discard</button>
          <button
            className="primary"
            disabled={apply.isPending}
            onClick={() => apply.mutate()}
          >
            Apply all
          </button>
          {apply.data && !apply.data.ok && (
            <span className="result err">{apply.data.message}</span>
          )}
          {apply.data && apply.data.ok && (
            <span className="result ok">
              Applied · {apply.data.changedFiles?.length ?? 0} file
              {(apply.data.changedFiles?.length ?? 0) === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}

      {sortedRows.length === 0 ? (
        <div className="empty">
          <div className="icon">∅</div>
          <h3>No links match</h3>
          <p>Try widening the filter, clearing the search box, or running an incremental scan.</p>
        </div>
      ) : (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader className="col-status" label="Status" sortKey="status" sort={sort} onSort={cycleSort} />
                <SortHeader className="col-post" label="Post" sortKey="post" sort={sort} onSort={cycleSort} />
                <SortHeader label="Link" sortKey="link" sort={sort} onSort={cycleSort} />
                <SortHeader label="Reason" sortKey="reason" sort={sort} onSort={cycleSort} />
                <th className="col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const k = encodeKey(row.postType, row.postSlug, row.link.id);
                const isExpanded = expanded === k;
                const draft = drafts[k];
                return (
                  <Row
                    key={k}
                    rowKey={k}
                    row={row}
                    draft={draft}
                    expanded={isExpanded}
                    siteUrl={siteUrl}
                    onToggle={onToggleRow}
                    onChange={setDraftForKey}
                    onCleanSuggestion={(target) => cleanSuggestion.mutate(target)}
                    onKeep={(target) => keepLink.mutate(target)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir } | null;
  onSort: (key: SortKey) => void;
  className?: string;
}): React.ReactElement {
  const active = sort?.key === sortKey;
  const arrow = active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      className={className}
      onClick={() => onSort(sortKey)}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      {arrow}
    </th>
  );
}

function encodeKey(type: 'post' | 'page', slug: string, linkId: string): string {
  return `${type}::${slug}::${linkId}`;
}

function decodeKey(k: string): [string, string, string] {
  const [type = '', slug = '', linkId = ''] = k.split('::');
  return [type, slug, linkId];
}

interface RowProps {
  rowKey: string;
  row: FlatLink;
  draft: DraftEdit | undefined;
  expanded: boolean;
  siteUrl: string | undefined;
  onToggle: (rowKey: string) => void;
  onChange: (key: string, d: DraftEdit | undefined) => void;
  onCleanSuggestion: (target: { postType: 'post' | 'page'; slug: string; linkId: string }) => void;
  onKeep: (target: { postType: 'post' | 'page'; slug: string; linkId: string }) => void;
}

const Row = memo(function Row({
  rowKey,
  row,
  draft,
  expanded,
  siteUrl,
  onToggle,
  onChange,
  onCleanSuggestion,
  onKeep,
}: RowProps): React.ReactElement {
  const verdict: Verdict | undefined = row.link.last_check?.verdict;
  const reasonCode = row.link.last_check?.reason_code ?? '';
  const reasonDetail = row.link.last_check?.reason_detail;
  const finalUrl = row.link.last_check?.final_url;
  const set = (d: DraftEdit | undefined): void => onChange(rowKey, d);
  const toggle = (): void => onToggle(rowKey);
  const meaningful = isMeaningfulDraft(draft);

  return (
    <>
      <tr
        className={expanded ? 'expanded' : ''}
        onClick={(e) => {
          const tgt = e.target as HTMLElement;
          if (tgt.tagName === 'A' || tgt.closest('button') || tgt.closest('input')) return;
          toggle();
        }}
        style={{ cursor: 'pointer' }}
      >
        <td className="col-status">
          <StatusBadge verdict={verdict} />
        </td>
        <td className="col-post">
          <div className="post-cell">
            <span className="type">{row.postType}</span>
            {(() => {
              const url = postUrl(siteUrl, row.postSlug);
              return url ? (
                <a
                  className="post-link"
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`open ${url}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  /{row.postSlug}
                </a>
              ) : (
                <span>/{row.postSlug}</span>
              );
            })()}
          </div>
        </td>
        <td>
          <div className="href-cell">
            <a
              className="href"
              href={row.link.href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
            >
              {row.link.href}
            </a>
            {row.link.anchor_text && (
              <span className="anchor-text">“{row.link.anchor_text}”</span>
            )}
            {finalUrl && finalUrl !== row.link.href && (
              <span className="final-url">{finalUrl}</span>
            )}
            {row.link.suggestion && <SuggestionLine suggestion={row.link.suggestion} />}
          </div>
        </td>
        <td>
          <div className="reason-cell">
            {verdict ? formatReason(reasonCode, reasonDetail) : <span className="muted">—</span>}
          </div>
        </td>
        <td className="col-action">
          <div className="row-actions">
            {expanded ? (
              <button
                className="ghost sm"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle();
                }}
              >
                Close
              </button>
            ) : row.link.action?.applied_at ? (
              <span className="applied">applied</span>
            ) : meaningful ? (
              <span className="badge muted">{draft!.action}</span>
            ) : (
              <button
                className="ghost sm"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle();
                }}
              >
                Edit
              </button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} style={{ padding: 0 }}>
            <div className="action-editor">
              {row.link.not_editable ? (
                <p className="not-editable-note">
                  Link metadata is incomplete (parse5 didn’t report offsets); edit the file by hand.
                </p>
              ) : (
                <>
                  {row.link.suggestion && row.link.suggestion.confirmed !== 'cleaned' && (
                    <SuggestionEditor
                      suggestion={row.link.suggestion}
                      onConfirm={() => {
                        if (row.link.suggestion?.url) {
                          set({ action: 'replace', newHref: row.link.suggestion.url });
                        }
                      }}
                      onClean={() =>
                        onCleanSuggestion({
                          postType: row.postType,
                          slug: row.postSlug,
                          linkId: row.link.id,
                        })
                      }
                    />
                  )}
                  <div className="action-radios">
                    <label>
                      <input
                        type="radio"
                        name={`act-${row.link.id}`}
                        checked={draft?.action === 'replace'}
                        onChange={() =>
                          set({ action: 'replace', newHref: draft?.newHref ?? '' })
                        }
                      />
                      Replace
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`act-${row.link.id}`}
                        checked={draft?.action === 'remove'}
                        onChange={() => set({ action: 'remove' })}
                      />
                      Remove
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`act-${row.link.id}`}
                        checked={draft?.action === 'keep'}
                        onChange={() =>
                          onKeep({
                            postType: row.postType,
                            slug: row.postSlug,
                            linkId: row.link.id,
                          })
                        }
                      />
                      Keep
                    </label>
                    {meaningful && (
                      <button className="ghost sm" onClick={() => set(undefined)}>
                        Clear
                      </button>
                    )}
                  </div>
                  {draft?.action === 'replace' && (
                    <div className="url-input">
                      <input
                        type="url"
                        placeholder="New URL"
                        value={draft.newHref ?? ''}
                        onChange={(e) => set({ action: 'replace', newHref: e.target.value })}
                        autoFocus
                      />
                    </div>
                  )}
                  <p className="help">
                    Pending edits are queued. Use <strong>Apply all</strong> at the top to write
                    them to disk in one batch.
                  </p>
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
});

function SuggestionEditor({
  suggestion,
  onConfirm,
  onClean,
}: {
  suggestion: LinkSuggestion;
  onConfirm: () => void;
  onClean: () => void;
}): React.ReactElement {
  if (!suggestion.url) {
    return (
      <div className="suggestion-card none">
        <div className="head">
          <span>✗ no replacement found by the LLM</span>
        </div>
        {suggestion.note && <div className="note">{suggestion.note}</div>}
        <div className="actions-row">
          <button className="ghost sm" onClick={onClean}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="suggestion-card">
      <div className="head">
        <span>✨ suggestion available</span>
        <span className={`sugg-conf conf-${suggestion.confidence}`}>{suggestion.confidence}</span>
      </div>
      <div className="url-row">
        <a href={suggestion.url} target="_blank" rel="noreferrer noopener">
          {suggestion.url}
        </a>
      </div>
      {suggestion.note && <div className="note">— {suggestion.note}</div>}
      <div className="actions-row">
        <button className="primary sm" onClick={onConfirm}>
          Confirm
        </button>
        <button className="sm" onClick={onClean}>
          Clean
        </button>
        <span className="or">— or override below —</span>
      </div>
    </div>
  );
}
