import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Server-side ordering for every rent-request desk (RentPipelineQueue, the Service Center vetting queue and the Tenant Ops
 * pipeline hub). The database ranks the requests a desk has already loaded, joins the tenant payment score in one RPC
 * (`rent_request_desk_order`) and returns each request's rank; the client only reads that rank. It never computes a score and
 * never changes which requests a desk loads, so each desk's limit and pagination are exactly as before.
 *
 *   best_payers (default): score high to low, then created_at oldest first
 *   newest / oldest:       created_at
 *
 * Read-only. If the RPC fails the desk simply keeps the order it already had.
 */
export type RentDeskSort = 'best_payers' | 'newest' | 'oldest';

export const DEFAULT_RENT_DESK_SORT: RentDeskSort = 'best_payers';

export const RENT_DESK_SORT_LABELS: Record<RentDeskSort, string> = {
  best_payers: 'Best payers first',
  newest: 'Newest first',
  oldest: 'Oldest first',
};

/** Next sort when a single toggle cycles through the modes. */
export const nextRentDeskSort = (s: RentDeskSort): RentDeskSort =>
  s === 'best_payers' ? 'newest' : s === 'newest' ? 'oldest' : 'best_payers';

export interface RentDeskOrderRow {
  request_id: string;
  tenant_id: string | null;
  rank: number;
  score: number | null;
  label: 'proven_good' | 'good_agent_pick' | 'average' | 'watch' | null;
  reason: string | null;
  basis: 'history' | 'new' | null;
}

export interface RentDeskOrder {
  sort: RentDeskSort;
  byId: Map<string, RentDeskOrderRow>;
}

/** The payment fields a desk row carries once the server order is joined in. */
export interface RentDeskScoreFields {
  payment_score?: number | null;
  payment_label?: RentDeskOrderRow['label'];
  payment_reason?: string | null;
  payment_basis?: RentDeskOrderRow['basis'];
}

export async function fetchRentDeskOrder(ids: string[], sort: RentDeskSort): Promise<RentDeskOrder> {
  const { data, error } = await (supabase.rpc as any)('rent_request_desk_order', {
    p_request_ids: ids,
    p_sort: sort,
  });
  if (error) throw error;
  const byId = new Map<string, RentDeskOrderRow>();
  ((data ?? []) as RentDeskOrderRow[]).forEach((r) => byId.set(r.request_id, r));
  return { sort, byId };
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
 * Fetches the server order for the loaded requests. Does nothing for an empty desk. The query is separate from the desk's own
 * data query, so changing the sort never reloads the desk.
 */
export function useRentDeskOrder(ids: string[], sort: RentDeskSort = DEFAULT_RENT_DESK_SORT) {
  const key = useMemo(() => rentDeskIdsKey(ids), [ids]);
  return useQuery<RentDeskOrder>({
    queryKey: ['rent-desk-order', sort, key],
    enabled: ids.length > 0,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    // one quick retry, then the desk falls back to the order it already has (a failed order never blocks a desk for long)
    retry: 1,
    retryDelay: 300,
    queryFn: () => fetchRentDeskOrder(ids, sort),
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

/** Adds the payment score, label and reason to each row. Returns `rows` itself when there is no order yet. */
export function withRentDeskScores<T extends { id: string }>(
  rows: T[],
  order: RentDeskOrder | undefined,
): (T & RentDeskScoreFields)[] {
  if (!order || order.byId.size === 0) return rows;
  return rows.map((row) => {
    const o = order.byId.get(row.id);
    if (!o) return row;
    return { ...row, payment_score: o.score, payment_label: o.label, payment_reason: o.reason, payment_basis: o.basis };
  });
}
