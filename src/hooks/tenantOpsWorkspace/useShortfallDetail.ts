/** Reads tops_shortfall_detail (or its v2, see shortfallRpcNames.ts)(...) — one row per short Rent Plan, optionally for one group, server-searched, server-sorted and server-paged. Also exports a helper that walks every page for CSV export. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { AreaLevel } from './useAreaBook';
import type { ShortfallGroup } from './useShortfallBreakdown';
import { SHORTFALL_DETAIL_RPC, SHORTFALL_USE_FOLLOWUPS } from './shortfallRpcNames';
import type { ShortfallFollowupFilter } from './useShortfallFollowups';

const anyDb = supabase as any;

export type ShortfallSortKey =
  | 'short_ugx'
  | 'expected_ugx'
  | 'collected_ugx'
  | 'days_behind'
  | 'periods_behind'
  | 'oldest_unpaid_due'
  | 'last_paid_at'
  | 'tenant_name'
  | 'agent_name'
  | 'service_centre'
  | 'district'
  | 'plan_code';

export interface ShortfallDetailRow {
  rent_request_id: string;
  plan_code: string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  service_centre_id: string | null;
  service_centre: string | null;
  district: string | null;
  expected_ugx: number;
  collected_ugx: number;
  short_ugx: number;
  days_behind: number | null;
  periods_behind: number | null;
  cadence: string | null;
  /** Server-built: "3 days" for daily Rent Plans, "2 weeks" for weekly ones; null until a schedule exists. */
  cadence_label: string | null;
  oldest_unpaid_due: string | null;
  last_paid_at: string | null;
}

export interface ShortfallDetailParams {
  startIso: string;
  endIso: string;
  /** Omit both group and groupKey for every short Rent Plan. */
  group?: ShortfallGroup | null;
  groupKey?: string | null;
  areaLevel?: AreaLevel;
  search?: string;
  sort?: ShortfallSortKey;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** Follow-up state filter (needs tops_shortfall_detail_v3). Omit or 'all' for every short Rent Plan. */
  followup?: ShortfallFollowupFilter;
}

export interface ShortfallDetailResult {
  totalCount: number;
  totalShortUgx: number;
  rows: ShortfallDetailRow[];
}

export const SHORTFALL_EXPORT_PAGE = 200;
const SHORTFALL_EXPORT_MAX_ROWS = 10_000;

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function fetchShortfallDetail(p: ShortfallDetailParams): Promise<ShortfallDetailResult> {
  const search = p.search?.trim();
  const { data, error } = await anyDb.rpc(SHORTFALL_DETAIL_RPC, {
    p_start: p.startIso,
    p_end: p.endIso,
    p_group: p.group ?? null,
    p_group_key: p.groupKey ?? null,
    p_area_level: p.areaLevel ?? 'district',
    p_search: search ? search : null,
    p_sort: p.sort ?? 'short_ugx',
    p_dir: p.dir ?? 'desc',
    p_limit: p.limit ?? 50,
    p_offset: p.offset ?? 0,
    // Only sent when filtering, so an unfiltered call is byte-for-byte what v2 received.
    ...(SHORTFALL_USE_FOLLOWUPS && p.followup && p.followup !== 'all' ? { p_followup: p.followup } : {}),
  });
  if (error) throw error;
  const raw = (data ?? {}) as Record<string, any>;
  return {
    totalCount: Number(raw.total_count ?? 0),
    totalShortUgx: Number(raw.total_short_ugx ?? 0),
    rows: ((raw.rows ?? []) as Record<string, any>[]).map((r) => ({
      rent_request_id: r.rent_request_id,
      plan_code: r.plan_code,
      tenant_id: r.tenant_id ?? null,
      tenant_name: r.tenant_name ?? null,
      tenant_phone: r.tenant_phone ?? null,
      agent_id: r.agent_id ?? null,
      agent_name: r.agent_name ?? null,
      agent_phone: r.agent_phone ?? null,
      service_centre_id: r.service_centre_id ?? null,
      service_centre: r.service_centre ?? null,
      district: r.district ?? null,
      expected_ugx: Number(r.expected_ugx),
      collected_ugx: Number(r.collected_ugx),
      short_ugx: Number(r.short_ugx),
      days_behind: numOrNull(r.days_behind),
      periods_behind: numOrNull(r.periods_behind),
      cadence: r.cadence ?? null,
      cadence_label: r.cadence_label ?? null,
      oldest_unpaid_due: r.oldest_unpaid_due ?? null,
      last_paid_at: r.last_paid_at ?? null,
    })),
  };
}

export function useShortfallDetail(params: ShortfallDetailParams, enabled = true) {
  const level = params.group === 'area' ? (params.areaLevel ?? 'district') : null;
  return useQuery({
    queryKey: [
      'tenantOpsWorkspace',
      'shortfallDetail',
      params.group ?? null,
      params.groupKey ?? null,
      level,
      params.startIso,
      params.endIso,
      params.search?.trim() ?? '',
      params.sort ?? 'short_ugx',
      params.dir ?? 'desc',
      params.limit ?? 50,
      params.offset ?? 0,
      params.followup ?? 'all',
    ],
    queryFn: () => fetchShortfallDetail(params),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    // Keep the previous page mounted while the next page / search / sort loads, but
    // not when a different group (or a different group's row) has been opened.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === (params.group ?? null) &&
      previousQuery?.queryKey[3] === (params.groupKey ?? null) &&
      previousQuery?.queryKey[4] === level
        ? keepPreviousData(previous)
        : undefined,
  });
}

/**
 * Walks every page of the same filtered, sorted result for CSV export (the
 * RPC caps a page at 200 rows). Stops at SHORTFALL_EXPORT_MAX_ROWS and reports
 * `truncated` rather than looping unbounded.
 */
export async function fetchAllShortfallDetail(
  params: Omit<ShortfallDetailParams, 'limit' | 'offset'>,
): Promise<ShortfallDetailResult & { truncated: boolean }> {
  const rows: ShortfallDetailRow[] = [];
  let offset = 0;
  let totalCount = 0;
  let totalShortUgx = 0;
  while (rows.length < SHORTFALL_EXPORT_MAX_ROWS) {
    const page = await fetchShortfallDetail({ ...params, limit: SHORTFALL_EXPORT_PAGE, offset });
    totalCount = page.totalCount;
    totalShortUgx = page.totalShortUgx;
    rows.push(...page.rows);
    offset += SHORTFALL_EXPORT_PAGE;
    if (page.rows.length === 0 || offset >= totalCount) break;
  }
  return { rows, totalCount, totalShortUgx, truncated: rows.length < totalCount };
}
