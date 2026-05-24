import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsPluginStorage } from '../../host/plugin-storage.js';
import { reclassify403 } from './reclassify.js';
import {
  loadIndex,
  loadSidecar,
  saveSidecar,
  SCHEMA_VERSION,
  type LinkRecord,
  type PostSidecar,
} from './sidecar.js';

function link(id: string, lastCheck: Partial<LinkRecord['last_check']>): LinkRecord {
  return {
    id,
    href: `https://x.test/${id}`,
    href_normalized: `https://x.test/${id}`,
    anchor_text: id,
    tag_start: 0,
    tag_end: 0,
    inner_start: 0,
    inner_end: 0,
    href_value_start: 0,
    href_value_end: 0,
    href_quote: '"',
    body_hash_at_extraction: 'sha256:x',
    last_check: {
      checked_at: '2026-05-09T00:00:00.000Z',
      verdict: 'OK',
      reason_code: '',
      ...lastCheck,
    },
  };
}

async function setup(links: LinkRecord[]): Promise<FsPluginStorage> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmsi-bl-reclassify-'));
  const storage = new FsPluginStorage(path.join(dir, '.cmsinsight', 'broken-links'));
  const sidecar: PostSidecar = {
    schema_version: SCHEMA_VERSION,
    post_id: 1,
    type: 'post',
    slug: 'p1',
    file_path: 'posts/p1.html',
    body_hash: 'sha256:x',
    last_scanned: '2026-05-09T00:00:00.000Z',
    links,
  };
  await saveSidecar(storage, sidecar);
  return storage;
}

describe('reclassify403', () => {
  it('flips a 403 from OK to BROKEN when treating 403 as broken', async () => {
    const storage = await setup([
      link('a', { http_status: 403, verdict: 'OK', reason_code: 'http_403_protected' }),
    ]);

    const res = await reclassify403(storage, true);
    expect(res).toEqual({ linksChanged: 1, postsChanged: 1 });

    const sc = await loadSidecar(storage, 'post', 'p1');
    expect(sc?.links[0]?.last_check?.verdict).toBe('BROKEN');
    expect(sc?.links[0]?.last_check?.reason_code).toBe('http_403');
    expect(sc?.links[0]?.last_check?.reason_detail).toBeUndefined();
    // checked_at is preserved — nothing was re-fetched.
    expect(sc?.links[0]?.last_check?.checked_at).toBe('2026-05-09T00:00:00.000Z');

    const idx = await loadIndex(storage);
    expect(idx?.totals.broken).toBe(1);
    expect(idx?.totals.ok).toBe(0);
  });

  it('flips a 403 from BROKEN to OK when not treating 403 as broken', async () => {
    const storage = await setup([
      link('a', { http_status: 403, verdict: 'BROKEN', reason_code: 'http_403' }),
    ]);

    const res = await reclassify403(storage, false);
    expect(res.linksChanged).toBe(1);

    const sc = await loadSidecar(storage, 'post', 'p1');
    expect(sc?.links[0]?.last_check?.verdict).toBe('OK');
    expect(sc?.links[0]?.last_check?.reason_code).toBe('http_403_protected');

    const idx = await loadIndex(storage);
    expect(idx?.totals.ok).toBe(1);
    expect(idx?.totals.broken).toBe(0);
  });

  it('leaves non-403 links untouched and reports no change when nothing flips', async () => {
    const storage = await setup([
      link('a', { http_status: 404, verdict: 'BROKEN', reason_code: 'http_404' }),
      link('b', { http_status: 200, verdict: 'OK', reason_code: 'ok' }),
      // Already in the target state for treatAsBroken=false.
      link('c', { http_status: 403, verdict: 'OK', reason_code: 'http_403_protected' }),
    ]);

    const res = await reclassify403(storage, false);
    expect(res).toEqual({ linksChanged: 0, postsChanged: 0 });

    const sc = await loadSidecar(storage, 'post', 'p1');
    expect(sc?.links[0]?.last_check?.verdict).toBe('BROKEN'); // 404 stays broken
    expect(sc?.links[1]?.last_check?.verdict).toBe('OK');
    expect(sc?.links[2]?.last_check?.verdict).toBe('OK');
  });
});
