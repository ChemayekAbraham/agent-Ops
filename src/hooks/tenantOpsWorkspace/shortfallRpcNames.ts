/**
 * Which shortfall RPCs the Collection Shortfall page reads.
 *
 * The v2 functions return exactly the v1 money figures; the only difference is that
 * days behind / oldest missed date / the Ageing buckets are filled for plans with no
 * instalment schedule, from the pinned daily bills and receipts (first in, first out).
 * Set SHORTFALL_USE_AGE_FALLBACK to false to go back to the original functions.
 *
 * tops_shortfall_detail_v3 is v2 plus the follow-up filter (All / Not followed up /
 * Promised to pay / Promise date passed). Set SHORTFALL_USE_FOLLOWUPS to false to drop
 * back to the v2 (or v1) detail function; the page then hides the follow-up filter.
 */
export const SHORTFALL_USE_AGE_FALLBACK = true;
export const SHORTFALL_USE_FOLLOWUPS = true;

/**
 * The Workspace counts every Rent Plan from the shared payout clock (the day after the landlord
 * was paid, the same start Agent Monitoring uses). The v2 breakdown and v3 detail functions have
 * *_amclock versions with identical arguments and return shape; set SHORTFALL_USE_AMCLOCK to false
 * to read the saved-clock functions again. (The older v1 / v2-detail fallbacks have no clock version.)
 */
export const SHORTFALL_USE_AMCLOCK = true;
const clockName = (name: string, hasClockVersion: boolean) =>
  SHORTFALL_USE_AMCLOCK && hasClockVersion ? `${name}_amclock` : name;

export const SHORTFALL_BREAKDOWN_RPC = SHORTFALL_USE_AGE_FALLBACK
  ? clockName('tops_shortfall_breakdown_v2', true)
  : 'tops_shortfall_breakdown';

export const SHORTFALL_DETAIL_RPC = SHORTFALL_USE_FOLLOWUPS
  ? clockName('tops_shortfall_detail_v3', true)
  : SHORTFALL_USE_AGE_FALLBACK
    ? 'tops_shortfall_detail_v2'
    : 'tops_shortfall_detail';
