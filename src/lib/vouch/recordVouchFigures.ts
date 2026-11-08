import type { TrustProfile } from '@/hooks/useTrustProfile';

/**
 * The figures a lender's vouch record is stamped with, or the reason it cannot be recorded.
 *
 * From Partner Returns 4b (owner decision D9) the vouch limit and the trust score are null for a viewer who
 * may not see the person's Returns. Until the owner decides what such a viewer gets (a Returns-free limit
 * from the server, or no vouch at all), recording fails closed: a null limit must never become a vouch of
 * UGX 0 (Math.min(x, null) === 0), and a null score must never be stamped on the record.
 */
export type RecordVouchFigures =
  | { ok: true; limit: number; score: number; tier: string }
  | { ok: false; error: string };

export const VOUCH_FIGURES_UNAVAILABLE =
  "Can't record this yet: Welile's vouch figures for this person are not available to you. Nothing was saved.";

export function recordVouchFigures(trust: Pick<TrustProfile['trust'], 'borrowing_limit_ugx' | 'score' | 'tier'>): RecordVouchFigures {
  const limit = trust?.borrowing_limit_ugx;
  const score = trust?.score;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0
    || typeof score !== 'number' || !Number.isFinite(score)) {
    return { ok: false, error: VOUCH_FIGURES_UNAVAILABLE };
  }
  return { ok: true, limit, score, tier: trust.tier };
}
