import { randomUUID } from 'node:crypto';
import type { ExtractedImage } from './extract.js';
import type { AltFinding } from './sidecar.js';

export interface MergeOptions {
  /** When false, suppress findings whose only rule match is D3 (`alt=""`). */
  flagEmptyAlt: boolean;
  /**
   * When true, currently-fine imgs that were previously fixed by the user are kept as
   * `status: 'fixed'` rows so the row stays editable. Use this from the `applyAction`
   * path, where the user just clicked Apply all and may want to re-edit immediately.
   *
   * When false, those rows are dropped: a fresh `Check new` / `Full check` should
   * surface only currently-flagged imgs, so once a fix is confirmed on disk it goes
   * away from the UI.
   */
  preserveFixed: boolean;
}

/**
 * Reconcile a fresh extraction with the previous sidecar's findings.
 *
 * Match strategy: same `src`, walked in document order — within each src bucket the Nth
 * new img matches the Nth previous finding. This survives byte-shift edits because we
 * never reorder or duplicate `<img>` tags during apply (we only mutate the alt attribute).
 *
 * Output rules:
 * - Currently flagged img → finding with `status: 'open'` and refreshed offsets.
 *   `applied_alt` is preserved from the previous record (so the form stays pre-filled
 *   even when the user manually reverted the file).
 * - Currently fine img with a previous `applied_alt` → finding with `status: 'fixed'`
 *   and refreshed offsets, kept as a re-editable row.
 * - Currently fine img with no previous record → not a finding, dropped.
 * - Previous finding whose img is gone from the body → dropped.
 */
export function mergeFindings(
  current: ReadonlyArray<ExtractedImage>,
  previous: ReadonlyArray<AltFinding>,
  opts: MergeOptions,
): AltFinding[] {
  // Group previous findings by src in document order so we can shift through them.
  const queues = new Map<string, AltFinding[]>();
  for (const f of previous) {
    const arr = queues.get(f.src) ?? [];
    arr.push(f);
    queues.set(f.src, arr);
  }

  const out: AltFinding[] = [];
  for (const img of current) {
    const matched = queues.get(img.src)?.shift();

    let effectiveRule = img.rule;
    if (effectiveRule === 'D3' && !opts.flagEmptyAlt) effectiveRule = undefined;

    if (effectiveRule) {
      out.push({
        id: matched?.id ?? `f-${randomUUID().slice(0, 8)}`,
        src: img.src,
        rule: effectiveRule,
        status: 'open',
        tag_start: img.tag_start,
        tag_end: img.tag_end,
        alt_value_start: img.alt_value_start,
        alt_value_end: img.alt_value_end,
        alt_quote: img.alt_quote,
        context_before: img.context_before,
        context_after: img.context_after,
        not_editable: img.not_editable,
        applied_alt: matched?.applied_alt,
        applied_at: matched?.applied_at,
      });
    } else if (opts.preserveFixed && matched?.applied_alt) {
      out.push({
        id: matched.id,
        src: img.src,
        rule: undefined,
        status: 'fixed',
        tag_start: img.tag_start,
        tag_end: img.tag_end,
        alt_value_start: img.alt_value_start,
        alt_value_end: img.alt_value_end,
        alt_quote: img.alt_quote,
        context_before: img.context_before,
        context_after: img.context_after,
        not_editable: img.not_editable,
        applied_alt: matched.applied_alt,
        applied_at: matched.applied_at,
      });
    }
    // else: fine img — drop. Either it was never tracked, or it was previously fixed
    // and the caller doesn't want fixed rows to linger past this scan.
  }
  return out;
}
