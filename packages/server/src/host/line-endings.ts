export type LineEnding = 'LF' | 'CRLF';

export function detectLineEnding(text: string): LineEnding {
  const firstCrlf = text.indexOf('\r\n');
  if (firstCrlf === -1) return 'LF';
  const firstLf = text.indexOf('\n');
  return firstLf === firstCrlf + 1 ? 'CRLF' : 'LF';
}
