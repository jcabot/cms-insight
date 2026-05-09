import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type FlatAltFinding, type SetAltEdit } from '../api/client.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { subscribeSse } from '../api/sse.js';

const PLUGIN_ID = 'missing-alt-text';

const RULE_LABEL: Record<string, string> = {
  D1: 'no alt',
  D2: 'whitespace alt',
  D3: 'empty alt',
};

interface PostGroup {
  postType: 'post' | 'page';
  slug: string;
  filePath: string;
  findings: FlatAltFinding[];
}

function postUrl(siteUrl: string | undefined, slug: string): string | undefined {
  if (!siteUrl) return undefined;
  return `${siteUrl.replace(/\/+$/, '')}/${slug}/`;
}

function groupByPost(findings: FlatAltFinding[]): PostGroup[] {
  const map = new Map<string, PostGroup>();
  for (const f of findings) {
    const key = `${f.postType}/${f.postSlug}`;
    let g = map.get(key);
    if (!g) {
      g = { postType: f.postType, slug: f.postSlug, filePath: f.filePath, findings: [] };
      map.set(key, g);
    }
    g.findings.push(f);
  }
  return [...map.values()];
}

function Thumbnail({ src }: { src: string }): React.ReactElement {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="finding-thumb broken"
        title="Image failed to load — click to open the URL anyway"
      >
        <span aria-hidden>🖼?</span>
      </a>
    );
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="finding-thumb" title="Open image in new tab">
      <img
        src={src}
        loading="lazy"
        referrerPolicy="no-referrer"
        alt=""
        onError={() => setBroken(true)}
      />
    </a>
  );
}

function FindingRow({
  flat,
  busy,
  hideWhenFixed,
  draftValue,
  onDraftChange,
}: {
  flat: FlatAltFinding;
  busy: boolean;
  hideWhenFixed: boolean;
  /** Defined only when the user has typed something different from `applied_alt`. */
  draftValue: string | undefined;
  onDraftChange: (next: string | undefined) => void;
}): React.ReactElement | null {
  const f = flat.finding;
  if (hideWhenFixed && f.status === 'fixed') return null;

  const applied = f.applied_alt ?? '';
  const inputValue = draftValue ?? applied;
  const isDraft = draftValue !== undefined && draftValue !== applied;
  const isFixed = f.status === 'fixed';

  function handleChange(next: string): void {
    if (next === applied) {
      // No change vs. on-disk state — drop any draft.
      onDraftChange(undefined);
    } else {
      onDraftChange(next);
    }
  }

  return (
    <div className={`finding-card${isFixed ? ' fixed' : ''}${isDraft ? ' has-draft' : ''}`}>
      <Thumbnail src={f.src} />
      <div className="finding-main">
        <div className="finding-meta">
          {f.rule ? (
            <span className={`badge rule rule-${f.rule}`}>{RULE_LABEL[f.rule] ?? f.rule}</span>
          ) : (
            <span className="badge fixed">Fixed</span>
          )}
          <a
            href={f.src}
            target="_blank"
            rel="noopener noreferrer"
            className="mono finding-src-link"
            title={`Open image: ${f.src}`}
          >
            {f.src}
          </a>
          {isDraft && <span className="badge draft">Pending</span>}
        </div>
        {(f.context_before || f.context_after) && (
          <div className="finding-context mono">
            <span className="muted">…{f.context_before}</span>
            <span className="finding-context-tag">[&lt;img&gt;]</span>
            <span className="muted">{f.context_after}…</span>
          </div>
        )}
        {!f.not_editable && (
          <div className="finding-form">
            <input
              type="text"
              placeholder={isFixed ? 'Edit the alt text — empty to clear' : 'Describe the image…'}
              value={inputValue}
              onChange={(e) => handleChange(e.target.value)}
              disabled={busy}
            />
            {isDraft && (
              <button
                type="button"
                className="ghost"
                onClick={() => onDraftChange(undefined)}
                disabled={busy}
                title="Discard this row's pending change"
              >
                Discard
              </button>
            )}
          </div>
        )}
        {f.not_editable && (
          <p className="muted finding-noedit">
            Not editable — extraction couldn't pin down byte offsets. Re-run the analysis after the
            next post update.
          </p>
        )}
      </div>
    </div>
  );
}

export function MissingAltTextRun(): React.ReactElement {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['results', PLUGIN_ID],
    queryFn: api.altResults,
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
  const [hideFixed, setHideFixed] = useState(true);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  /** Pending draft alt text per finding id. Absent when the row matches its on-disk state. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    return () => {
      sseUnsubRef.current?.();
    };
  }, []);

  const setDraftFor = (findingId: string, value: string | undefined): void => {
    setDrafts((prev) => {
      if (value === undefined) {
        if (!(findingId in prev)) return prev;
        const next = { ...prev };
        delete next[findingId];
        return next;
      }
      return { ...prev, [findingId]: value };
    });
  };

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

  const findingsById = useMemo(() => {
    const m = new Map<string, FlatAltFinding>();
    for (const f of data?.findings ?? []) m.set(f.finding.id, f);
    return m;
  }, [data]);

  const draftEdits = useMemo<SetAltEdit[]>(() => {
    const out: SetAltEdit[] = [];
    for (const [findingId, value] of Object.entries(drafts)) {
      const flat = findingsById.get(findingId);
      if (!flat) continue;
      out.push({
        postType: flat.postType,
        slug: flat.postSlug,
        findingId,
        altText: value,
      });
    }
    return out;
  }, [drafts, findingsById]);

  // Drop drafts that no longer have a corresponding finding (e.g. after a re-run).
  useEffect(() => {
    setDrafts((prev) => {
      const stale = Object.keys(prev).filter((id) => !findingsById.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [findingsById]);

  const applyAll = useMutation({
    mutationFn: (edits: SetAltEdit[]) => api.applySetAlt(edits),
    onSuccess: (res, edits) => {
      if (res.ok) {
        setDrafts({});
        setToast({
          kind: 'success',
          text: `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'}.`,
        });
        qc.invalidateQueries({ queryKey: ['results', PLUGIN_ID] });
        qc.invalidateQueries({ queryKey: ['sites'] });
      } else {
        setToast({ kind: 'error', text: res.message ?? 'Apply failed' });
      }
    },
    onError: (err) => setToast({ kind: 'error', text: (err as Error).message }),
  });

  const groups = useMemo<PostGroup[]>(() => groupByPost(data?.findings ?? []), [data]);
  const totals = data?.index?.totals;

  if (isLoading) return <p className="loading">Loading findings…</p>;
  if (error) return <p className="error-line">{(error as Error).message}</p>;

  const lastRun = data?.index?.last_run_completed;
  const draftCount = draftEdits.length;
  const busy = applyAll.isPending;

  return (
    <article>
      <header className="page-header">
        <div className="title">
          <span className="eyebrow">Missing alt text</span>
          <h1>Images without alt attributes</h1>
          <p className="muted">
            Per WCAG 1.1.1, every meaningful <code className="mono">&lt;img&gt;</code> needs an
            alt description. Type alt text into any row, then <strong>Apply all</strong> writes
            every pending change in one batch. Click a thumbnail to open the original image.
          </p>
        </div>
        <div className="actions row gap-sm">
          <button
            type="button"
            disabled={progress.running || startRun.isPending}
            onClick={() => startRun.mutate({})}
            title="Re-parse only posts whose body changed since the last run (body-hash gated)"
          >
            Check new
          </button>
          <button
            type="button"
            disabled={progress.running || startRun.isPending}
            onClick={() => startRun.mutate({ reExtractAll: true })}
            title="Re-parse every post regardless of body hash"
          >
            Full check
          </button>
          {progress.running && (
            <button type="button" onClick={() => cancelRun.mutate()}>
              Cancel
            </button>
          )}
        </div>
      </header>

      <section className="kpi-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="kpi">
          <div className="kpi-label">Findings open</div>
          <div className="kpi-value broken">{totals?.findings_open ?? 0}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Findings fixed</div>
          <div className="kpi-value ok">{totals?.findings_fixed ?? 0}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Total images scanned</div>
          <div className="kpi-value">{totals?.total_images ?? 0}</div>
        </div>
      </section>

      {(progress.running || progress.finalSummary || progress.message) && (
        <section className="progress-section">
          <ProgressBar
            running={progress.running}
            done={progress.done}
            total={progress.total}
          />
          {progress.message && <p className="muted progress-message">{progress.message}</p>}
          {progress.finalSummary && (
            <p className="progress-final">{progress.finalSummary}</p>
          )}
        </section>
      )}

      {lastRun && (
        <p className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
          Last run completed {new Date(lastRun).toLocaleString()}.
        </p>
      )}

      <div
        className="row gap-sm apply-bar"
        style={{ marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={hideFixed}
            onChange={(e) => setHideFixed(e.target.checked)}
          />
          Hide fixed findings
        </label>
        <span className="apply-bar-spacer" />
        <span className="muted apply-bar-count">
          {draftCount} pending change{draftCount === 1 ? '' : 's'}
        </span>
        <button type="button" disabled={busy || draftCount === 0} onClick={() => setDrafts({})}>
          Discard
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || draftCount === 0}
          onClick={() => applyAll.mutate(draftEdits)}
          title="Write every pending alt-text change to the post files in one batch"
        >
          Apply all
          {draftCount > 0 ? ` (${draftCount})` : ''}
        </button>
      </div>

      {groups.length === 0 ? (
        <section className="empty-section">
          <p className="muted">
            No findings yet. Click <strong>Check new</strong> to scan the active site.
          </p>
        </section>
      ) : (
        <div className="post-groups">
          {groups.map((g) => {
            const visible = hideFixed
              ? g.findings.filter(
                  (f) => f.finding.status !== 'fixed' || drafts[f.finding.id] !== undefined,
                )
              : g.findings;
            if (visible.length === 0) return null;
            const groupHref = postUrl(siteUrl, g.slug);
            return (
              <section key={`${g.postType}/${g.slug}`} className="post-group">
                <h3 className="post-group-head">
                  <span className="post-type">{g.postType}</span>
                  {groupHref ? (
                    <a
                      href={groupHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono post-group-link"
                      title={`Open ${g.postType}: ${groupHref}`}
                    >
                      {groupHref}
                    </a>
                  ) : (
                    <code className="mono">{g.slug}</code>
                  )}
                  <span className="muted post-count">
                    {visible.length} {visible.length === 1 ? 'finding' : 'findings'}
                  </span>
                </h3>
                <div className="finding-list">
                  {visible.map((flat) => (
                    <FindingRow
                      key={flat.finding.id}
                      flat={flat}
                      busy={busy}
                      hideWhenFixed={hideFixed && drafts[flat.finding.id] === undefined}
                      draftValue={drafts[flat.finding.id]}
                      onDraftChange={(next) => setDraftFor(flat.finding.id, next)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`}>
          <span>{toast.text}</span>
        </div>
      )}
    </article>
  );
}
