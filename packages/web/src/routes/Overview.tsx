import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

export function Overview(): React.ReactElement {
  const { data, isLoading, error } = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
  });

  if (isLoading) return <p className="loading">Loading overview…</p>;
  if (error) return <p className="error-line">{(error as Error).message}</p>;
  if (!data) return <></>;

  const totalAll = data.totals.posts + data.totals.pages;
  const maxCat = data.categories[0]?.count ?? 1;
  const maxTag = data.tags[0]?.count ?? 1;
  const maxYear = Math.max(...data.by_year.map((y) => y.count), 1);

  return (
    <article>
      <header className="page-header">
        <div className="title">
          <span className="eyebrow">Active site overview</span>
          <h1>Content at a glance</h1>
          <p className="muted">
            Stats for the currently active site. Computed from front-matter only — no body
            parsing, no link checks.
          </p>
        </div>
      </header>

      <section className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Total documents</div>
          <div className="kpi-value brand">{totalAll}</div>
          <div className="kpi-sub">
            {data.totals.posts} posts · {data.totals.pages} pages
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Posts</div>
          <div className="kpi-value">{data.totals.posts}</div>
          <div className="kpi-sub">articles &amp; entries</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Pages</div>
          <div className="kpi-value">{data.totals.pages}</div>
          <div className="kpi-sub">about, contact, &amp;c.</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Statuses</div>
          <div className="kpi-value">{Object.keys(data.totals.by_status).length}</div>
          <div className="kpi-sub">
            {Object.entries(data.totals.by_status)
              .map(([k, v]) => `${v} ${k}`)
              .join(' · ') || '—'}
          </div>
        </div>
      </section>

      <section className="cards-grid">
        <div className="card">
          <header className="card-header">
            <h2>Categories</h2>
            <span className="meta">{data.categories.length} unique</span>
          </header>
          <div className="card-body">
            {data.categories.length === 0 ? (
              <p className="empty" style={{ padding: 24 }}>
                No categories recorded.
              </p>
            ) : (
              <ul className="tax-list">
                {data.categories.slice(0, 12).map((c) => (
                  <li key={c.name}>
                    <span className="name">{c.name}</span>
                    <div className="bar">
                      <span style={{ width: `${(c.count / maxCat) * 100}%` }} />
                    </div>
                    <span className="count">{c.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="card">
          <header className="card-header">
            <h2>Tags</h2>
            <span className="meta">{data.tags.length} unique</span>
          </header>
          <div className="card-body">
            {data.tags.length === 0 ? (
              <p className="empty" style={{ padding: 24 }}>
                No tags recorded.
              </p>
            ) : (
              <ul className="tax-list">
                {data.tags.slice(0, 12).map((t) => (
                  <li key={t.name}>
                    <span className="name">{t.name}</span>
                    <div className="bar">
                      <span style={{ width: `${(t.count / maxTag) * 100}%` }} />
                    </div>
                    <span className="count">{t.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="card">
          <header className="card-header">
            <h2>By year</h2>
            <span className="meta">{data.by_year.length} years</span>
          </header>
          <div className="card-body">
            {data.by_year.length === 0 ? (
              <p className="empty" style={{ padding: 24 }}>
                No dated posts.
              </p>
            ) : (
              <ul className="tax-list">
                {data.by_year.map((y) => (
                  <li key={y.year}>
                    <span className="name mono">{y.year}</span>
                    <div className="bar">
                      <span style={{ width: `${(y.count / maxYear) * 100}%` }} />
                    </div>
                    <span className="count">{y.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section className="card" style={{ marginBottom: 28 }}>
        <header className="card-header">
          <h2>Recently modified</h2>
          <span className="meta">
            {data.recent_modified.length} of {totalAll}
          </span>
        </header>
        <div className="card-body">
          {data.recent_modified.length === 0 ? (
            <p className="muted" style={{ padding: 12 }}>
              No posts to report.
            </p>
          ) : (
            <ul className="recent-list">
              {data.recent_modified.map((p) => (
                <li key={`${p.type}/${p.slug}`}>
                  <span className="tag">{p.type}</span>
                  <span className="title-cell">
                    {p.title}
                    <span className="slug">/{p.slug}</span>
                  </span>
                  <span className="when">
                    {(p.modified_gmt ?? '').replace('T', ' ').slice(0, 16) || '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {data.orphan_pages.length > 0 && (
        <section className="card">
          <header className="card-header">
            <h2>Orphan pages</h2>
            <span className="meta">{data.orphan_pages.length} pages with unknown parent</span>
          </header>
          <div className="card-body">
            <ul className="recent-list">
              {data.orphan_pages.map((o) => (
                <li key={o.slug}>
                  <span className="tag orphan">orphan</span>
                  <span className="title-cell">
                    {o.title}
                    <span className="slug">/{o.slug}</span>
                  </span>
                  <span className="when">parent={o.parent}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </article>
  );
}
