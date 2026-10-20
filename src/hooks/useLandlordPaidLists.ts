import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { matchesPaidVerification, type PaidVerificationFilter, type PaidListResponse, type PaidListRow, type PaidListTab } from '@/lib/landlordPaidLists';

const num = (v: unknown) => Number(v) || 0;

/** One page of a Landlord Ops paid list (landlord_ops_paid_lists). Read-only. */
export async function fetchLandlordPaidList(tab: PaidListTab, search: string, limit: number, offset: number): Promise<PaidListResponse> {
  const { data, error } = await supabase.rpc('landlord_ops_paid_lists', {
    p_tab: tab,
    p_search: search.trim() || undefined,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  const d = data as unknown as PaidListResponse;
  return {
    ...d,
    total: num(d.total),
    counts: { paid_repaying: num(d.counts?.paid_repaying), completed: num(d.counts?.completed) },
    rows: (d.rows ?? []).map((r: PaidListRow) => ({
      ...r,
      tenant_count: num(r.tenant_count), plans_total: num(r.plans_total), repaying_plans: num(r.repaying_plans), completed_plans: num(r.completed_plans), active_plans: num(r.active_plans),
      total_rent: num(r.total_rent), total_repaid: num(r.total_repaid), balance_left: num(r.balance_left), received_amount: num(r.received_amount),
    })),
  };
}

/** The page on screen for a tab, a search and a page number (1-based). */
export async function fetchFilteredLandlordPaidList(tab: PaidListTab, search: string, filter: PaidVerificationFilter): Promise<PaidListResponse> {
  const first = await fetchLandlordPaidList(tab, search, 200, 0);
  const rows = [...first.rows];
  while (rows.length < first.total) {
    const next = await fetchLandlordPaidList(tab, search, 200, rows.length);
    if (next.rows.length === 0) throw new Error('Paid landlord list changed. Please refresh.');
    rows.push(...next.rows);
  }
  const matching = rows.filter(row => matchesPaidVerification(row, filter));
  return { ...first, rows: matching, total: matching.length, offset: 0 };
}

export function useLandlordPaidList(params: { tab: PaidListTab; search: string; page: number; perPage: number; enabled?: boolean; verification?: PaidVerificationFilter }) {
  const { tab, search, page, perPage, enabled = true, verification = 'all' } = params;
  return useQuery({
    queryKey: ['landlord-paid-lists', 'page', { tab, search: search.trim(), page: verification === 'all' ? page : undefined, perPage, verification }],
    queryFn: () => verification === 'all'
      ? fetchLandlordPaidList(tab, search, perPage, Math.max(0, (page - 1) * perPage))
      : fetchFilteredLandlordPaidList(tab, search, verification),
    select: data => verification === 'all' ? data : { ...data, rows: data.rows.slice(Math.max(0, (page - 1) * perPage), page * perPage) },
    staleTime: 30_000,
    retry: false,
    enabled,
  });
}

/**
 * How many landlords are in each tab for the search on screen, so a tab's count and the list it opens always agree. One landlord per call:
 * only the totals are read.
 */
export function useLandlordPaidListCounts(params: { search: string; enabled?: boolean }) {
  const { search, enabled = true } = params;
  return useQuery({
    queryKey: ['landlord-paid-lists', 'counts', { search: search.trim() }],
    queryFn: async () => {
      const [pr, c] = await Promise.all([fetchLandlordPaidList('paid_repaying', search, 1, 0), fetchLandlordPaidList('completed', search, 1, 0)]);
      return { paid_repaying: pr.total, completed: c.total };
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
    enabled,
  });
}
