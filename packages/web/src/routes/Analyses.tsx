import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

const STATUS_LABEL: Record<string, string> = {
  running: 'In progress',
  finished: 'Completed',
  cancelled: 'Cancelled',
  error: 'Errored',
};

export function Analyses(): React.ReactElement {
  const { data, isLoading, error } = useQuery({
    queryKey: ['analyses'],
    queryFn: api.analyses,
  });

  if (isLoading) return <p className="loading">Loading analyses…</p>;
  if (error) return <p className="error-line">{(error as Error).message}</p>;

  return (
    <article>
      <header className="page-header">
        <div className="title">
          <span className="eyebrow">Available analyses</span>
          <h1>Pluggable analyses</h1>
          <p className="muted">
            Each entry is an analysis the host runs against the working content directory. v1 ships
            broken-link detection.
          </p>
        </div>
      </header>

      <ol className="toc-list">
        {(data ?? []).map((a, i) => (
          <li key={a.id}>
            <Link to={`/analyses/${a.resultsView}`}>
              <div className="toc-row">
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <div className="name">{a.displayName}</div>
                  <div className="desc">{a.description}</div>
                </div>
                <div className="last">
                  {a.lastRun ? (
                    <>
                      <span>{STATUS_LABEL[a.lastRun.status] ?? a.lastRun.status}</span>
                      <span className="v">{a.lastRun.startedAt.replace('T', ' ').slice(0, 16)}</span>
                    </>
                  ) : (
                    <span className="muted">Never run</span>
                  )}
                </div>
                <button className="primary">Open →</button>
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </article>
  );
}
