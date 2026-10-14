import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  DEFAULT_RENT_DESK_SORT,
  NO_RENT_DESK_FILTERS,
  RENT_DESK_SORT_LABELS,
  isRentDeskFiltered,
  rentDeskFilterArgs,
  type RentDeskFilters,
  type RentDeskLabel,
  type RentDeskSort,
} from '@/lib/rentDeskFilters';

export { DEFAULT_RENT_DESK_SORT, RENT_DESK_SORT_LABELS };
export type { RentDeskSort };

/**
 * Server-side ordering and filtering for every rent-request desk (RentPipelineQueue, the Service Center vetting queue and
 * the Tenant Ops pipeline hub). The database ranks the requests a desk has already loaded, joins the tenant payment score
 * in one RPC (`rent_request_desk_order`), applies the paying-label and arrival-date filters, and returns each request's
 * rank, score, label, reason, whether it matches the filters, and the number that do. The client only reads those answers:
 * it never computes a score, evaluates a label or a date, or counts the matches itself. It never changes which requests a
 * desk loads, so each desk's limit and pagination are exactly as before.
 *
 *   best_payers (default): score high to low, then created_at oldest first
 *   newest / oldest:       created_at
 *   arrival:               the day the request was created, Kampala time (today, last 7 days, custom range)
 *
 * Read-only. If the RPC fails the desk simply keeps the order it already had and shows every row.
 */

/** Next sort when a single toggle cycles through the modes. */
export const nextRentDeskSort = (s: RentDeskSort): RentDeskSort =>
  s === 'best_payers' ? 'newest' : s === 'newest' ? 'oldest' : 'best_payers';

export interface RentDeskOrderRow {
  request_id: string;
  tenant_id: string | null;
  rank: number;
  score: number | null;
  label: RentDeskLabel | null;
  reason: string | null;
  basis: 'history' | 'new' | null;
  /** Does this request pass the filters? True for every row when no filter is set. */
  matches: boolean;
  match_count: number;
  total_count: number;
}

export interface RentDeskOrder {
  sort: RentDeskSort;
  /** True when a filter was applied; rows with `matches === false` are hidden by the desk. */
  filtered: boolean;
  /** The server's count of requests that match, and of requests ranked. */
  matchCount: number;
  totalCount: number;
  byId: Map<string, RentDeskOrderRow>;
}

/** The payment fields a desk row carries once the server order is joined in. */
export interface RentDeskScoreFields {
  payment_score?: number | null;
  payment_label?: RentDeskLabel | null;
  payment_reason?: string | null;
  payment_basis?: RentDeskOrderRow['basis'];
  /** The server's answer to "does this row pass the desk filters?" (absent until the order has loaded). */
  desk_match?: boolean;
}

export async function fetchRentDeskOrder(
  ids: string[],
  sort: RentDeskSort,
  filters: RentDeskFilters = NO_RENT_DESK_FILTERS,
): Promise<RentDeskOrder> {
  const { data, error } = await (supabase.rpc as any)('rent_request_desk_order', {
    p_request_ids: ids,
    p_sort: sort,
    ...rentDeskFilterArgs(filters),
  });
  if (error) throw error;
  const rows = (data ?? []) as RentDeskOrderRow[];
  const byId = new Map<string, RentDeskOrderRow>();
  rows.forEach((r) => byId.set(r.request_id, r));
  return {
    sort,
    filtered: isRentDeskFiltered(filters),
    matchCount: rows.length ? rows[0].match_count : 0,
    totalCount: rows.length ? rows[0].total_count : 0,
    byId,
  };
}

/** Stable, short cache key for a set of ids (order-independent), so a large desk does not put thousands of ids in a query key. */
export function rentDeskIdsKey(ids: string[]): string {
  const sorted = [...ids].sort();
  let h = 0x811c9dc5;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2c;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${sorted.length}:${h.toString(16)}`;
}

/**
 * Fetches the server order (and filter answers) for the loaded requests. Does nothing for an empty desk, or when `enabled`
 * is false. The query is separate from the desk's own data query, so changing the sort or a filter never reloads the desk.
 */
export function useRentDeskOrder(
  ids: string[],
  sort: RentDeskSort = DEFAULT_RENT_DESK_SORT,
  filters: RentDeskFilters = NO_RENT_DESK_FILTERS,
  options: { enabled?: boolean } = {},
) {
  const key = useMemo(() => rentDeskIdsKey(ids), [ids]);
  const args = JSON.stringify(rentDeskFilterArgs(filters));
  return useQuery<RentDeskOrder>({
    queryKey: ['rent-desk-order', sort, args, key],
    enabled: ids.length > 0 && options.enabled !== false,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    // one quick retry, then the desk falls back to the order it already has (a failed order never blocks a desk for long)
    retry: 1,
    retryDelay: 300,
    queryFn: () => fetchRentDeskOrder(ids, sort, filters),
  });
}

/**
 * Puts rows in the server's order. Rows the server did not rank (or all rows, while the order is loading or if it failed)
 * keep the order they came in, after the ranked ones. Pure; never mutates `rows`.
 */
export function orderByRentDesk<T extends { id: string }>(rows: T[], order: RentDeskOrder | undefined): T[] {
  if (!order || order.byId.size === 0) return rows;
  const ranked: { row: T; rank: number }[] = [];
  const unranked: T[] = [];
  for (const row of rows) {
    const o = order.byId.get(row.id);
    if (o) ranked.push({ row, rank: o.rank });
    else unranked.push(row);
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return [...ranked.map((x) => x.row), ...unranked];
}

/**
 * Hides the rows the server says do not match the filters. With no filter, or no answer from the server (still loading, or
 * it failed), every row is kept. A row the server did not rank cannot be said to match, so it is hidden under a filter.
 */
export function filterByRentDesk<T extends { id: string }>(rows: T[], order: RentDeskOrder | undefined): T[] {
  if (!order || !order.filtered) return rows;
  return rows.filter((row) => order.byId.get(row.id)?.matches === true);
}

/** Adds the payment score, label, reason and filter answer to each row. Returns `rows` itself when there is no order yet. */
export function withRentDeskScores<T extends { id: string }>(
  rows: T[],
  order: RentDeskOrder | undefined,
): (T & RentDeskScoreFields)[] {
  if (!order || order.byId.size === 0) return rows;
  return rows.map((row) => {
    const o = order.byId.get(row.id);
    if (!o) return row;
    return {
      ...row,
      payment_score: o.score,
      payment_label: o.label,
      payment_reason: o.reason,
      payment_basis: o.basis,
      desk_match: o.matches,
    };
  });
}
