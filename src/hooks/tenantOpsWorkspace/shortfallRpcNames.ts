/**
 * Which shortfall RPCs the Collection Shortfall page reads.
 *
 * The v2 functions return exactly the v1 money figures; the only difference is that
 * days behind / oldest missed date / the Ageing buckets are filled for plans with no
 * instalment schedule, from the pinned daily bills and receipts (first in, first out).
 * Set this to false to go back to the original functions — nothing else changes.
 */
export const SHORTFALL_USE_AGE_FALLBACK = true;

export const SHORTFALL_BREAKDOWN_RPC = SHORTFALL_USE_AGE_FALLBACK
  ? 'tops_shortfall_breakdown_v2'
  : 'tops_shortfall_breakdown';

export const SHORTFALL_DETAIL_RPC = SHORTFALL_USE_AGE_FALLBACK
  ? 'tops_shortfall_detail_v2'
  : 'tops_shortfall_detail';
