import { createHash } from 'node:crypto';

export function hashBytes(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}
