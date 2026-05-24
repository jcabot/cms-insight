import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

export function Settings(): React.ReactElement {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings,
  });

  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const refresh = useMutation({
    mutationFn: () => api.settings(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setToast({ kind: 'success', text: 'Settings reloaded.' });
    },
    onError: (err) => setToast({ kind: 'error', text: (err as Error).message }),
  });

  const saveBrokenLinks = useMutation({
    mutationFn: (next: { treat_403_as_broken: boolean }) =>
      api.putSettings({ plugins: { 'broken-links': next } }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      const n = res.reclassified?.linksChanged ?? 0;
      if (n > 0) {
        qc.invalidateQueries({ queryKey: ['results', 'broken-links'] });
        qc.invalidateQueries({ queryKey: ['sites'] });
      }
      setToast({
        kind: 'success',
        text:
          n > 0
            ? `Saved — reclassified ${n} existing 403 link${n === 1 ? '' : 's'}.`
            : 'Broken-links settings saved.',
      });
    },
    onError: (err) => setToast({ kind: 'error', text: (err as Error).message }),
  });

  if (isLoading) return <p className="loading">Loading settings…</p>;
  if (error) return <p className="error-line">{(error as Error).message}</p>;
  if (!data) return <></>;

  const noActive = !data.activeSiteId;

  return (
    <article>
      <header className="page-header">
        <div className="title">
          <span className="eyebrow">Settings</span>
          <h1>Workspace &amp; configuration</h1>
          <p className="muted">
            Read-only view of the active site's environment. To switch which site is active, go
            back to <strong>Home</strong>.
          </p>
        </div>
        <div className="actions">
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            Reload
          </button>
        </div>
      </header>

      {noActive && (
        <p className="error-line">
          No active site. Pick one on the Home page before editing per-site settings.
        </p>
      )}

      <section className="settings-section">
        <div className="section-head">
          <h2>Active site</h2>
          <p>
            Multi-site root: <code className="mono">{data.root}</code>
          </p>
        </div>
        <div className="dir-row" style={{ gridTemplateColumns: '1fr' }}>
          {noActive ? (
            <span className="field-help">No site is active.</span>
          ) : (
            <span className="field-help">
              Active: <code className="mono">{data.contentDir}</code>
              {data.siteUrl && (
                <>
                  {' '}
                  · site: <code className="mono">{data.siteUrl}</code>
                </>
              )}
            </span>
          )}
        </div>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h2>LLM features</h2>
          <p>
            AI suggestions for broken-link replacements use an external LLM API. Disabled by
            default; opt in by setting an API key in your environment.
          </p>
        </div>
        <div className="dir-row" style={{ gridTemplateColumns: '1fr' }}>
          {data.llmEnabled ? (
            <div className="llm-status">
              <span className="status-dot" aria-hidden />
              LLM features enabled · provider:{' '}
              <code className="mono">
                {(data.config as { llm?: { provider?: string; model?: string } }).llm?.provider ??
                  '—'}
              </code>
              {' · '}model:{' '}
              <code className="mono">
                {(data.config as { llm?: { provider?: string; model?: string } }).llm?.model ?? '—'}
              </code>
            </div>
          ) : (
            <div className="llm-status disabled">
              <span className="status-dot muted" aria-hidden />
              LLM features disabled
              {data.llmDisabledReason && (
                <>
                  {' · '}
                  <code className="mono">{data.llmDisabledReason}</code>
                </>
              )}
            </div>
          )}
          <p className="field-help" style={{ marginTop: 8 }}>
            To enable Anthropic Claude suggestions, provide an{' '}
            <code className="mono">ANTHROPIC_API_KEY</code> in any of these places (highest
            priority first), then restart the server:
          </p>
          <ol className="field-help" style={{ marginTop: 6, paddingLeft: 24 }}>
            <li>
              Shell environment:{' '}
              <code className="mono">export ANTHROPIC_API_KEY=sk-ant-...</code>
            </li>
            {!noActive && (
              <li>
                Per-site file:{' '}
                <code className="mono">{data.contentDir.replace(/\\/g, '/')}/.cmsinsight/.env</code>
              </li>
            )}
            <li>
              Root-shared file:{' '}
              <code className="mono">{data.root.replace(/\\/g, '/')}/.cmsinsight/.env</code>
            </li>
            <li>
              User-wide file: <code className="mono">~/.cmsinsight/.env</code>
            </li>
          </ol>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h2>Broken-links options</h2>
          <p>Per-site tweaks for the broken-links analysis. Takes effect on the next scan.</p>
        </div>
        <div className="dir-row" style={{ gridTemplateColumns: '1fr' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              disabled={noActive || saveBrokenLinks.isPending}
              checked={
                !!(data.config as {
                  plugins?: { 'broken-links'?: { treat_403_as_broken?: boolean } };
                }).plugins?.['broken-links']?.treat_403_as_broken
              }
              onChange={(e) =>
                saveBrokenLinks.mutate({ treat_403_as_broken: e.target.checked })
              }
            />
            <span>
              Treat <code className="mono">403 Forbidden</code> responses as broken
            </span>
          </label>
          <p className="field-help" style={{ marginTop: 6 }}>
            Off by default — most 403s come from auth-protected pages that work fine in a
            browser, so flagging them as broken would be a false positive.
          </p>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h2>Configuration</h2>
          {!noActive && (
            <p>
              Edit <code className="mono">.cmsinsight/config.toml</code> in the active site's
              directory and restart to change ports, concurrency, TTLs, or tracking-param strip
              lists.
            </p>
          )}
        </div>
        <pre className="config-block">{JSON.stringify(data.config, null, 2)}</pre>
      </section>

      {toast && (
        <div className={`toast ${toast.kind}`}>
          <span>{toast.text}</span>
        </div>
      )}
    </article>
  );
}
