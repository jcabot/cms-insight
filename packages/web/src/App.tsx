import { NavLink, Route, Routes } from 'react-router-dom';
import { Home } from './routes/Home.js';
import { Overview } from './routes/Overview.js';
import { Analyses } from './routes/Analyses.js';
import { BrokenLinksRun } from './routes/BrokenLinksRun.js';
import { Settings } from './routes/Settings.js';
import { SiteSwitcher } from './components/SiteSwitcher.js';

export function App(): React.ReactElement {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>c</span>
          cms-insight
        </div>
        <nav className="topnav">
          <NavLink to="/">Home</NavLink>
          <NavLink to="/overview">Active site overview</NavLink>
          <NavLink to="/analyses">Analyses</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="topbar-right">
          <SiteSwitcher />
        </div>
      </header>

      <main className="page">
        <div className="page-inner">
          <Routes>
            <Route path="/" element={<Home />} />
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
