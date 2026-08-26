/**
 * Range-scoped data source for Daily Repayments *exports only*.
 *
 * The on-screen Daily Repayments view (src/components/reports/DailyRentReport.tsx)
 * keeps its own single-day query and calculations untouched. This hook mirrors the
 * exact same source table (`agent_collections`), the same enrichment joins and the
 * same derivations, but over an operator-chosen date range so each section can be
 * exported for a period. Batched `in()` lookups keep it free of N+1 round-trips.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';

export type RepaymentStatus = 'successful' | 'pending' | 'failed';

export interface RangeCollectionRow {
  id: string;
  created_at: string;
  amount: number | null;
  payment_method: string | null;
  tracking_id: string | null;
  momo_transaction_id: string | null;
  notes: string | null;
  float_before: number | null;
  float_after: number | null;
  agent_id: string | null;
  tenant_id: string | null;
  rent_request_id: string | null;
}

export interface EnrichedRangeRow extends RangeCollectionRow {
  tenant_name: string;
  tenant_phone: string;
  agent_name: string;
  landlord_name: string;
  property: string;
  status: RepaymentStatus;
  commission: number;
  outstanding: number;
}

export interface RangeTotals {
  sum: number;
  count: number;
  successful: number;
  pending: number;
  failed: number;
  commission: number;
  outstanding: number;
  avg: number;
  uniqueTenants: number;
  uniqueAgents: number;
}

export interface AgentRankRow {
  agent_id: string;
  agent_name: string;
  count: number;
  total: number;
  commission: number;
  successful: number;
  failed: number;
  pending: number;
}

const BATCH = 100;

async function batchedMap<T>(
  ids: string[],
  fetcher: (chunk: string[]) => Promise<T[]>,
  key: (row: T) => string,
): Promise<Record<string, T>> {
  const map: Record<string, T> = {};
  for (let i = 0; i < ids.length; i += BATCH) {
    const rows = await fetcher(ids.slice(i, i + BATCH));
    rows.forEach(r => { map[key(r)] = r; });
  }
  return map;
}

export function useDailyRepaymentsRange(from: string, to: string, enabled = true) {
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['daily-repayments-range', from, to],
    enabled: enabled && !!from && !!to,
    staleTime: 60_000,
    queryFn: async () => {
      const fromIso = new Date(`${from}T00:00:00`).toISOString();
      const toIso = new Date(`${to}T23:59:59.999`).toISOString();

      const { data: collections, error } = await supabase
        .from('agent_collections')
        .select('id, created_at, amount, payment_method, tracking_id, momo_transaction_id, notes, float_before, float_after, agent_id, tenant_id, rent_request_id')
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .order('created_at', { ascending: false });
      if (error) throw error;

      const rows = (collections ?? []) as RangeCollectionRow[];

      const profileIds = [...new Set(rows.flatMap(r => [r.tenant_id, r.agent_id]).filter(Boolean) as string[])];
      const rentReqIds = [...new Set(rows.map(r => r.rent_request_id).filter(Boolean) as string[])];

      const [profileMap, rentReqMap] = await Promise.all([
        batchedMap(
          profileIds,
          async chunk => ((await supabase.from('profiles').select('id, full_name, phone').in('id', chunk)).data ?? []) as any[],
          (p: any) => p.id,
        ),
        batchedMap(
          rentReqIds,
          async chunk => ((await supabase.from('rent_requests').select('id, landlord_id, house_listing_id, rent_amount, total_repayment, amount_repaid').in('id', chunk)).data ?? []) as any[],
          (r: any) => r.id,
        ),
      ]);

      const landlordIds = [...new Set(Object.values(rentReqMap).map((r: any) => r.landlord_id).filter(Boolean) as string[])];
      const listingIds = [...new Set(Object.values(rentReqMap).map((r: any) => r.house_listing_id).filter(Boolean) as string[])];

      const [landlordMap, listingMap] = await Promise.all([
        batchedMap(
          landlordIds,
          async chunk => ((await supabase.from('landlords').select('id, full_name').in('id', chunk)).data ?? []) as any[],
          (l: any) => l.id,
        ),
        batchedMap(
          listingIds,
          async chunk => ((await supabase.from('house_listings').select('id, title, address').in('id', chunk)).data ?? []) as any[],
          (h: any) => h.id,
        ),
      ]);

      const enriched: EnrichedRangeRow[] = rows.map(r => {
        const rr = r.rent_request_id ? (rentReqMap as any)[r.rent_request_id] : null;
        const status: RepaymentStatus =
          r.amount && Number(r.amount) > 0 ? 'successful' : (Number(r.amount) === 0 ? 'pending' : 'failed');
        return {
          ...r,
          tenant_name: (profileMap as any)[r.tenant_id ?? '']?.full_name || '—',
          tenant_phone: (profileMap as any)[r.tenant_id ?? '']?.phone || '—',
          agent_name: (profileMap as any)[r.agent_id ?? '']?.full_name || '—',
          landlord_name: rr?.landlord_id ? (landlordMap as any)[rr.landlord_id]?.full_name || '—' : '—',
          property: rr?.house_listing_id
            ? ((listingMap as any)[rr.house_listing_id]?.title || (listingMap as any)[rr.house_listing_id]?.address || '—')
            : '—',
          status,
          commission: Math.round((Number(r.amount) || 0) * 0.1),
          outstanding: Math.max(0, (Number(rr?.total_repayment) || 0) - (Number(rr?.amount_repaid) || 0)),
        };
      });

      return enriched;
    },
  });

  const rows = data ?? [];

  const totals = useMemo<RangeTotals>(() => {
    let sum = 0, count = 0, successful = 0, pending = 0, failed = 0, commission = 0, outstanding = 0;
    const seenReq = new Set<string>();
    rows.forEach(r => {
      sum += Number(r.amount) || 0;
      count += 1;
      if (r.status === 'successful') successful += 1;
      else if (r.status === 'pending') pending += 1;
      else failed += 1;
      commission += r.commission;
      const key = r.rent_request_id ?? `t:${r.tenant_id}`;
      if (key && !seenReq.has(key)) {
        seenReq.add(key);
        outstanding += r.outstanding || 0;
      }
    });
    return {
      sum, count, successful, pending, failed, commission, outstanding,
      avg: count ? sum / count : 0,
      uniqueTenants: new Set(rows.map(r => r.tenant_id).filter(Boolean)).size,
      uniqueAgents: new Set(rows.map(r => r.agent_id).filter(Boolean)).size,
    };
  }, [rows]);

  const byHour = useMemo(() => {
    const buckets: Record<string, { amount: number; count: number }> = {};
    for (let h = 0; h < 24; h++) buckets[String(h).padStart(2, '0')] = { amount: 0, count: 0 };
    rows.forEach(r => {
      const h = format(new Date(r.created_at), 'HH');
      buckets[h] = { amount: (buckets[h]?.amount ?? 0) + (Number(r.amount) || 0), count: (buckets[h]?.count ?? 0) + 1 };
    });
    return Object.entries(buckets).map(([hour, v]) => ({ hour, amount: v.amount, count: v.count }));
  }, [rows]);

  const byMethod = useMemo(() => {
    const map: Record<string, { amount: number; count: number }> = {};
    rows.forEach(r => {
      const k = r.payment_method ?? 'unknown';
      map[k] = { amount: (map[k]?.amount ?? 0) + (Number(r.amount) || 0), count: (map[k]?.count ?? 0) + 1 };
    });
    return Object.entries(map)
      .map(([method, v]) => ({ method, amount: v.amount, count: v.count }))
      .sort((a, b) => b.amount - a.amount);
  }, [rows]);

  const byProperty = useMemo(() => {
    const map: Record<string, { amount: number; count: number; landlord: string }> = {};
    rows.forEach(r => {
      const k = r.property;
      map[k] = {
        amount: (map[k]?.amount ?? 0) + (Number(r.amount) || 0),
        count: (map[k]?.count ?? 0) + 1,
        landlord: map[k]?.landlord ?? r.landlord_name,
      };
    });
    return Object.entries(map)
      .map(([property, v]) => ({ property, amount: v.amount, count: v.count, landlord: v.landlord }))
      .sort((a, b) => b.amount - a.amount);
  }, [rows]);

  const byDay = useMemo(() => {
    const map: Record<string, { amount: number; count: number }> = {};
    rows.forEach(r => {
      const d = format(new Date(r.created_at), 'yyyy-MM-dd');
      map[d] = { amount: (map[d]?.amount ?? 0) + (Number(r.amount) || 0), count: (map[d]?.count ?? 0) + 1 };
    });
    return Object.entries(map)
      .map(([day, v]) => ({ day, amount: v.amount, count: v.count }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }, [rows]);

  const agentRanking = useMemo<AgentRankRow[]>(() => {
    const byAgent = new Map<string, AgentRankRow>();
    rows.forEach(r => {
      const id = r.agent_id ?? 'unknown';
      const cur = byAgent.get(id) ?? { agent_id: id, agent_name: r.agent_name, count: 0, total: 0, commission: 0, successful: 0, failed: 0, pending: 0 };
      cur.count += 1;
      cur.total += Number(r.amount) || 0;
      cur.commission += r.commission;
      if (r.status === 'successful') cur.successful += 1;
      else if (r.status === 'pending') cur.pending += 1;
      else cur.failed += 1;
      byAgent.set(id, cur);
    });
    return [...byAgent.values()].sort((a, b) => b.total - a.total);
  }, [rows]);

  return { rows, totals, byHour, byMethod, byProperty, byDay, agentRanking, isLoading, isFetching, refetch };
}
