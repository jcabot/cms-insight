import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SiteSummary } from '../api/client.js';
import { SiteCard } from '../components/SiteCard.js';

export function Home(): React.ReactElement {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['sites'],
    queryFn: api.listSites,
  });
  const { data: candidatesData } = useQuery({
    queryKey: ['site-candidates'],
    queryFn: api.listSiteCandidates,
    staleTime: 5_000,
  });

  const [showAdd, setShowAdd] = useState(false);
  const [pickRel, setPickRel] = useState('');
  const [customRel, setCustomRel] = useState('');
  const [labelDraft, setLabelDraft] = useState('');
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [draggedId, setDraggedId] = useState<string | undefined>(undefined);
  const [dragOverId, setDragOverId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function invalidateAll(): void {
    qc.invalidateQueries({ queryKey: ['sites'] });
    qc.invalidateQueries({ queryKey: ['site-candidates'] });
  }

  function invalidateSiteScopedQueries(): void {
    // After activate or remove, the implicit "active site" changed — refetch everything site-scoped.
    qc.invalidateQueries({ queryKey: ['settings'] });
    qc.invalidateQueries({ queryKey: ['overview'] });
    qc.invalidateQueries({ queryKey: ['analyses'] });
    qc.invalidateQueries({ queryKey: ['results'] });
  }

  const addSite = useMutation({
    mutationFn: (body: { relPath: string; label?: string }) => api.addSite(body),
    onSuccess: () => {
      setShowAdd(false);
      setPickRel('');
      setCustomRel('');
      setLabelDraft('');
      invalidateAll();
      invalidateSiteScopedQueries();
      setToast({ kind: 'success', text: 'Site added.' });
    },
    onError: (err) => setToast({ kind: 'error', text: (err as Error).message }),
  });

  const removeSite = useMutation({
    mutationFn: (id: string) => api.removeSite(id),
    onSuccess: () => {
      invalidateAll();
      invalidateSiteScopedQueries();
      setToast({ kind: 'success', text: 'Site removed.' });
    },
    onError: (err) => setToast({ kind: 'error', text: (err as Error).message }),
  });

  const renameSite = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => api.renameSite(id, label),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sites'] }),
    onError: (err) => setToast({ kind: 'error', text: (err as Error).message }),
  });

  const reorderSites = useMutation({
    mutationFn: (ids: string[]) => api.reorderSites(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sites'] }),
    onError: (err) => setToast({ kind: 'error', text: (err as Error).message }),
  });

  const activateSite = useMutation({
    mutationFn: (id: string) => api.activateSite(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sites'] });
      invalidateSiteScopedQueries();
    },
    onError: (err) => setToast({ kind: 'error', text: (err as Error).message }),
  });

  if (isLoading) return <p className="loading">Loading sites…</p>;
  if (error) return <p className="error-line">{(error as Error).message}</p>;

  const sites: SiteSummary[] = data?.sites ?? [];
  const candidates = candidatesData?.candidates ?? [];

  function moveSite(id: string, direction: -1 | 1): void {
    const idx = sites.findIndex((s) => s.id === id);
    const swap = idx + direction;
    if (idx === -1 || swap < 0 || swap >= sites.length) return;
    const next = [...sites];
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    reorderSites.mutate(next.map((s) => s.id));
  }

  function handleDragStart(id: string, e: React.DragEvent<HTMLLIElement>): void {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }

  function handleDragOver(id: string, e: React.DragEvent<HTMLLIElement>): void {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverId !== id) setDragOverId(id);
  }

  function handleDrop(targetId: string, e: React.DragEvent<HTMLLIElement>): void {
    e.preventDefault();
    setDragOverId(undefined);
    const sourceId = draggedId ?? e.dataTransfer.getData('text/plain');
    setDraggedId(undefined);
    if (!sourceId || sourceId === targetId) return;
    const ids = sites.map((s) => s.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    reorderSites.mutate(ids);
  }

  function handleDragEnd(): void {
    setDraggedId(undefined);
    setDragOverId(undefined);
  }

  const submitAdd = (): void => {
    const rel = (pickRel || customRel).trim();
    if (!rel) return;
    addSite.mutate({ relPath: rel, label: labelDraft.trim() || undefined });
  };

  return (
    <article>
      <header className="page-header">
        <div className="title">
          <span className="eyebrow">Sites</span>
          <h1>Linked sites</h1>
          <p className="muted">
            Each card is one wpsync content directory under{' '}
            <code className="mono">{data?.root ?? ''}</code>. Pick one to set it active — analyses
            run against the active site only.
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => setShowAdd((v) => !v)}
          >
            {showAdd ? 'Cancel' : '+ Add site'}
          </button>
        </div>
      </header>

      {showAdd && (
        <section className="settings-section">
          <div className="section-head">
            <h2>Add a site</h2>
            <p>
              The folder must contain <code className="mono">.wpsync/config.toml</code> with a{' '}
              <code className="mono">site_url</code> key.
            </p>
          </div>

          <div className="dir-row">
            <div className="field">
              <label className="field-label" htmlFor="pickRel">
                Subfolder of root
              </label>
              {candidates.length > 0 ? (
                <select
                  id="pickRel"
                  value={pickRel}
                  onChange={(e) => {
                    setPickRel(e.target.value);
                    setCustomRel('');
                  }}
                >
                  <option value="">— pick a candidate —</option>
                  {candidates.map((c) => (
                    <option key={c.relPath} value={c.relPath}>
                      {c.relPath}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="field-help">
                  No unregistered wpsync subfolders detected. Type one manually below.
                </span>
              )}
              <input
                className="mono"
                style={{ marginTop: 8 }}
                type="text"
                placeholder="…or relative path (e.g. blog-en)"
                value={customRel}
                onChange={(e) => {
                  setCustomRel(e.target.value);
                  setPickRel('');
                }}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="labelDraft">
                Label (optional)
              </label>
              <input
                id="labelDraft"
                type="text"
                placeholder="defaults to folder name"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
              />
            </div>
            <div className="row gap-sm" style={{ alignItems: 'flex-end' }}>
              <button
                className="primary"
                disabled={addSite.isPending || !(pickRel || customRel.trim())}
                onClick={submitAdd}
              >
                Add
              </button>
            </div>
          </div>
        </section>
      )}

      {sites.length === 0 ? (
        <section className="empty-section">
          <p className="muted">
            No sites yet. Click <strong>+ Add site</strong> above to register a wpsync content
            directory under <code className="mono">{data?.root ?? ''}</code>.
          </p>
        </section>
      ) : (
        <ol className="site-list">
          {sites.map((s, i) => (
            <SiteCard
              key={s.id}
              site={s}
              isFirst={i === 0}
              isLast={i === sites.length - 1}
              isDragOver={dragOverId === s.id && draggedId !== s.id}
              onActivate={() => activateSite.mutate(s.id)}
              onRename={(label) => renameSite.mutate({ id: s.id, label })}
              onRemove={() => removeSite.mutate(s.id)}
              onMove={(dir) => moveSite(s.id, dir)}
              onDragStart={(e) => handleDragStart(s.id, e)}
              onDragOver={(e) => handleDragOver(s.id, e)}
              onDrop={(e) => handleDrop(s.id, e)}
              onDragEnd={handleDragEnd}
            />
          ))}
        </ol>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`}>
          <span>{toast.text}</span>
        </div>
      )}
    </article>
  );
}
