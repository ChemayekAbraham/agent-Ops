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

export const SHORTFALL_BREAKDOWN_RPC = SHORTFALL_USE_AGE_FALLBACK
  ? 'tops_shortfall_breakdown_v2'
  : 'tops_shortfall_breakdown';

export const SHORTFALL_DETAIL_RPC = SHORTFALL_USE_FOLLOWUPS
  ? 'tops_shortfall_detail_v3'
  : SHORTFALL_USE_AGE_FALLBACK
    ? 'tops_shortfall_detail_v2'
    : 'tops_shortfall_detail';
