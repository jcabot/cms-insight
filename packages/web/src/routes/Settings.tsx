import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';

export function Settings(): React.ReactElement {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings,
  });

  const [dirInput, setDirInput] = useState('');
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (data?.contentDir && dirInput === '') setDirInput(data.contentDir);
  }, [data?.contentDir, dirInput]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const switchDir = useMutation({
    mutationFn: (dir: string) => api.setContentDir(dir),
    onSuccess: (res) => {
      if (res.ok) {
        qc.invalidateQueries();
        setToast({ kind: 'success', text: `Now reading from ${res.contentDir ?? 'new directory'}` });
      } else {
        setToast({ kind: 'error', text: res.message ?? 'failed to switch directory' });
      }
    },
    onError: (err) => {
      setToast({ kind: 'error', text: (err as Error).message });
    },
  });

  const switchAndRun = useMutation({
    mutationFn: async (dir: string) => {
      const res = await api.setContentDir(dir);
      if (!res.ok) throw new Error(res.message ?? 'failed to switch directory');
      await api.startRun('broken-links', {});
      return res;
    },
    onSuccess: (res) => {
      qc.invalidateQueries();
      setToast({
        kind: 'success',
        text: `Switched to ${res.contentDir ?? 'new directory'}; broken-links analysis started.`,
      });
      navigate('/analyses/broken-links');
    },
    onError: (err) => {
      setToast({ kind: 'error', text: (err as Error).message });
    },
  });

  if (isLoading) return <p className="loading">Loading settings…</p>;
  if (error) return <p className="error-line">{(error as Error).message}</p>;
  if (!data) return <></>;

  const dirty = dirInput.trim() !== data.contentDir;
  const busy = switchDir.isPending || switchAndRun.isPending;

  return (
    <article>
      <header className="page-header">
        <div className="title">
          <span className="eyebrow">Settings</span>
          <h1>Workspace &amp; configuration</h1>
          <p className="muted">
            Point the dashboard at any wpsync content directory and re-run the analysis.
          </p>
        </div>
      </header>

      <section className="settings-section">
        <div className="section-head">
          <h2>Working directory</h2>
          <p>
            The folder the dashboard reads from. Must contain <code className="mono">.wpsync/config.toml</code>{' '}
            with a <code className="mono">site_url</code> key, plus <code className="mono">posts/</code> and{' '}
            <code className="mono">pages/</code> subfolders.
          </p>
        </div>

        <div className="dir-row">
          <div className="field">
            <label className="field-label" htmlFor="dirInput">
              Path
            </label>
            <input
              id="dirInput"
              className="mono"
              type="text"
              value={dirInput}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setDirInput(e.target.value)}
              placeholder="/path/to/wpsync/content"
            />
            <span className="field-help">
              Currently reading: <code className="mono">{data.contentDir}</code>
              {data.siteUrl && (
                <>
                  {' '}
                  · site: <code className="mono">{data.siteUrl}</code>
                </>
              )}
            </span>
          </div>
          <div className="row gap-sm" style={{ alignItems: 'flex-end' }}>
            <button
              disabled={!dirty || busy}
              onClick={() => switchDir.mutate(dirInput.trim())}
            >
              Switch
            </button>
            <button
              className="primary"
              disabled={busy || dirInput.trim().length === 0}
              onClick={() => switchAndRun.mutate(dirInput.trim())}
            >
              Switch &amp; analyze
            </button>
          </div>
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
            To enable Anthropic Claude suggestions, provide an <code className="mono">ANTHROPIC_API_KEY</code>{' '}
            in any of these places (highest priority first), then restart the server:
          </p>
          <ol className="field-help" style={{ marginTop: 6, paddingLeft: 24 }}>
            <li>
              Shell environment:{' '}
              <code className="mono">export ANTHROPIC_API_KEY=sk-ant-...</code>
            </li>
            <li>
              Per-project file:{' '}
              <code className="mono">{data.contentDir.replace(/\\/g, '/')}/.cmsinsight/.env</code>
            </li>
            <li>
              User-wide file:{' '}
              <code className="mono">~/.cmsinsight/.env</code>
            </li>
          </ol>
          <p className="field-help" style={{ marginTop: 6 }}>
            Both <code className="mono">.env</code> paths are inside <code className="mono">.cmsinsight/</code>{' '}
            directories that the dashboard already keeps out of git. Format is one{' '}
            <code className="mono">KEY=value</code> per line.
          </p>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h2>Configuration</h2>
          <p>
            Edit <code className="mono">.cmsinsight/config.toml</code> in the working directory and
            restart to change ports, concurrency, TTLs, or tracking-param strip lists.
          </p>
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
