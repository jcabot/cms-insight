export function ProgressBar({
  done,
  total,
  running,
}: {
  done?: number;
  total?: number;
  running?: boolean;
}): React.ReactElement | null {
  if (total === undefined || total === 0) {
    if (running) {
      return (
        <div className="progress-running">
          <div className="progress-band" aria-label="working">
            <div className="bar" style={{ width: '100%' }} />
          </div>
        </div>
      );
    }
    return null;
  }
  const pct = Math.min(100, Math.round(((done ?? 0) / total) * 100));
  return (
    <div className={running ? 'progress-running' : ''}>
      <div className="progress-band" aria-label={`progress ${pct}%`}>
        <div className="bar" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
