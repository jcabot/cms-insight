import type { Verdict } from '../api/client.js';

const LABEL: Record<Verdict, string> = {
  BROKEN: 'Broken',
  SUSPICIOUS: 'Suspicious',
  OK: 'OK',
};

export function StatusBadge({
  verdict,
  className,
}: {
  verdict?: Verdict;
  className?: string;
}): React.ReactElement {
  if (!verdict) return <span className={`badge muted ${className ?? ''}`}>Pending</span>;
  const cls = verdict === 'BROKEN' ? 'broken' : verdict === 'SUSPICIOUS' ? 'suspicious' : 'ok';
  return <span className={`badge ${cls} ${className ?? ''}`}>{LABEL[verdict]}</span>;
}
