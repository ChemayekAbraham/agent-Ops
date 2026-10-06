/** Reads tops_shortfall_breakdown (or its v2, see shortfallRpcNames.ts)(p_start, p_end, p_group, p_area_level) — the collection shortfall grouped by tenant, agent, service centre, area or ageing, server-ordered by shortfall descending. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { AreaLevel } from './useAreaBook';
import { SHORTFALL_BREAKDOWN_RPC } from './shortfallRpcNames';

const anyDb = supabase as any;

export type ShortfallGroup = 'tenant' | 'agent' | 'service_centre' | 'area' | 'ageing';

export interface ShortfallBreakdownRow {
  group_key: string;
  group_name: string;
  parent_name: string | null;
  plan_count: number;
  tenant_count: number;
  expected_ugx: number;
  collected_ugx: number;
  short_ugx: number;
  short_pct: number | null;
  avg_days_behind: number | null;
  max_days_behind: number | null;
  oldest_unpaid_due: string | null;
}

export interface ShortfallBreakdownParams {
  startIso: string;
  endIso: string;
  group: ShortfallGroup;
  /** Only used when group === 'area'. */
  areaLevel?: AreaLevel;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

async function fetchShortfallBreakdown(p: ShortfallBreakdownParams): Promise<ShortfallBreakdownRow[]> {
  const { data, error } = await anyDb.rpc(SHORTFALL_BREAKDOWN_RPC, {
    p_start: p.startIso,
    p_end: p.endIso,
    p_group: p.group,
    p_area_level: p.areaLevel ?? 'district',
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    group_key: String(r.group_key),
    group_name: r.group_name,
    parent_name: r.parent_name ?? null,
    plan_count: Number(r.plan_count),
    tenant_count: Number(r.tenant_count),
    expected_ugx: Number(r.expected_ugx),
    collected_ugx: Number(r.collected_ugx),
    short_ugx: Number(r.short_ugx),
    short_pct: numOrNull(r.short_pct),
    avg_days_behind: numOrNull(r.avg_days_behind),
    max_days_behind: numOrNull(r.max_days_behind),
    oldest_unpaid_due: r.oldest_unpaid_due ?? null,
  }));
}

export function useShortfallBreakdown(params: ShortfallBreakdownParams, enabled = true) {
  const level = params.group === 'area' ? (params.areaLevel ?? 'district') : null;
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'shortfallBreakdown', params.group, level, params.startIso, params.endIso],
    queryFn: () => fetchShortfallBreakdown(params),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    // Keep the previous rows while a new date range loads, but never carry one
    // grouping's rows over into another (Agents must not briefly show Tenants).
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === params.group && previousQuery?.queryKey[3] === level
        ? keepPreviousData(previous)
        : undefined,
  });
}
