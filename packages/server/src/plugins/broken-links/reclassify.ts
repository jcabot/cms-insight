import type { PluginStorage } from '@cms-insight/plugin-api';
import {
  buildIndex,
  listAllSidecars,
  saveIndex,
  saveSidecar,
  type PostSidecar,
} from './sidecar.js';
import { verdictFor403 } from './verdict-403.js';

export interface Reclassify403Result {
  linksChanged: number;
  postsChanged: number;
}

/**
 * Re-derive the verdict of every already-checked 403 link from its stored `http_status`,
 * without re-fetching. Lets a `treat_403_as_broken` toggle flip OK<->BROKEN instantly
 * instead of silently waiting on a full per-site re-check. Only rewrites sidecars (and the
 * index) that actually change.
 */
export async function reclassify403(
  storage: PluginStorage,
  treatAsBroken: boolean,
): Promise<Reclassify403Result> {
  const target = verdictFor403(treatAsBroken);
  const all: PostSidecar[] = [];
  for await (const sc of listAllSidecars(storage)) all.push(sc);

  let linksChanged = 0;
  let postsChanged = 0;
  for (const sc of all) {
    let dirty = false;
    for (const link of sc.links) {
      const lc = link.last_check;
      if (!lc || lc.http_status !== 403) continue;
      if (lc.verdict === target.verdict && lc.reason_code === target.reason_code) continue;
      lc.verdict = target.verdict;
      lc.reason_code = target.reason_code;
      lc.reason_detail = target.reason_detail;
      linksChanged++;
      dirty = true;
    }
    if (dirty) {
      await saveSidecar(storage, sc);
      postsChanged++;
    }
  }

  if (linksChanged > 0) {
    await saveIndex(storage, buildIndex(all));
  }
  return { linksChanged, postsChanged };
}
