import type { Verdict } from './sidecar.js';

/**
 * The verdict for an HTTP 403 is a pure function of the stored status and the
 * `treat_403_as_broken` setting — no network call is needed to (re)derive it. Both the
 * live checker and the reclassify-on-toggle path go through here so they can't drift.
 */
export interface Verdict403 {
  verdict: Verdict;
  reason_code: string;
  reason_detail?: string;
}

export const HTTP_403_PROTECTED_DETAIL =
  'Treated as OK per treat_403_as_broken=false (auth-protected, not actually broken).';

export function verdictFor403(treatAsBroken: boolean): Verdict403 {
  return treatAsBroken
    ? { verdict: 'BROKEN', reason_code: 'http_403', reason_detail: undefined }
    : { verdict: 'OK', reason_code: 'http_403_protected', reason_detail: HTTP_403_PROTECTED_DETAIL };
}
