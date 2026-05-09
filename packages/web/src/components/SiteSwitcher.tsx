import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

export function SiteSwitcher(): React.ReactElement {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['sites'],
    queryFn: api.listSites,
    staleTime: 30_000,
  });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const activate = useMutation({
    mutationFn: (id: string) => api.activateSite(id),
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['sites'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      qc.invalidateQueries({ queryKey: ['analyses'] });
      qc.invalidateQueries({ queryKey: ['results'] });
    },
  });

  const sites = data?.sites ?? [];
  const active = sites.find((s) => s.id === data?.activeSiteId);
  const hasSites = sites.length > 0;

  return (
    <div className="site-switcher" ref={wrapRef}>
      <button
        type="button"
        className={`site-context-pill${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active?.relPath ?? 'No active site'}
      >
        <span className={`status-dot${active ? '' : ' muted'}`} aria-hidden />
        <span>
          <span className="label">{active ? 'active site' : 'no active site'}</span>
          <br />
          <span className="name">{active?.label ?? 'Pick one →'}</span>
        </span>
        <span className="caret" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="site-switcher-menu" role="menu">
          {!hasSites ? (
            <p className="empty">No sites registered yet.</p>
          ) : (
            <ul>
              {sites.map((s) => (
                <li key={s.id} role="menuitem">
                  <button
                    type="button"
                    className={`site-switcher-row${s.isActive ? ' is-active' : ''}`}
                    onClick={() => {
                      if (!s.isActive) activate.mutate(s.id);
                      else setOpen(false);
                    }}
                    disabled={activate.isPending}
                  >
                    <span className="check" aria-hidden>{s.isActive ? '✓' : ''}</span>
                    <span className="row-main">
                      <span className="row-label">{s.label}</span>
                      <span className="row-rel mono">{s.relPath}/</span>
                    </span>
                    {!s.isActive && <span className="row-action">Set active</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="site-switcher-foot">
            <Link to="/" onClick={() => setOpen(false)}>
              Manage sites →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
