import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Overview } from './routes/Overview.js';
import { Analyses } from './routes/Analyses.js';
import { BrokenLinksRun } from './routes/BrokenLinksRun.js';
import { Settings } from './routes/Settings.js';
import { api } from './api/client.js';

export function App(): React.ReactElement {
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings,
    staleTime: 30_000,
  });

  const dir = settings?.contentDir;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>c</span>
          cms-insight
        </div>
        <nav className="topnav">
          <NavLink to="/overview">Overview</NavLink>
          <NavLink to="/analyses">Analyses</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="topbar-right">
          <NavLink to="/settings" className="dir-pill" title={dir ?? ''}>
            <span className="status-dot" aria-hidden />
            <span>
              <span className="label">working dir</span>
              <br />
              <span className="path mono">{dir ?? 'loading…'}</span>
            </span>
          </NavLink>
        </div>
      </header>

      <main className="page">
        <div className="page-inner">
          <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<Overview />} />
            <Route path="/analyses" element={<Analyses />} />
            <Route path="/analyses/broken-links" element={<BrokenLinksRun />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
