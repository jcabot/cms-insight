const PRETTY_REASONS: Record<string, string> = {
  ok: 'OK',
  soft_404: 'Soft 404 (page not found)',
  parked_generic: 'Parked domain (generic)',
  dns_failure: 'DNS failure',
  invalid_url: 'Invalid URL',
  too_many_redirects: 'Too many redirects',
  network_aborted: 'Aborted',
};

export function formatReason(code: string, detail?: string): string {
  if (PRETTY_REASONS[code]) return detail ? `${PRETTY_REASONS[code]}: ${detail}` : PRETTY_REASONS[code];
  if (code.startsWith('http_')) return `HTTP ${code.slice(5)}${detail ? ` ${detail}` : ''}`;
  if (code.startsWith('parked_')) return `Parked (${code.slice(7)})`;
  if (code.startsWith('topic_shift_')) return `Redirects to ${code.slice('topic_shift_'.length)} content`;
  if (code.endsWith('_content')) return `${code.slice(0, -8)} content`;
  if (code.startsWith('network_')) return `Network: ${code.slice(8)}${detail ? ` (${detail})` : ''}`;
  return code;
}
