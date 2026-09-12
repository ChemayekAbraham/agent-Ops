import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';


/**
 * Read-only Landlord Float overview for Landlord Ops.
 *
 * Everything comes from the single SECURITY DEFINER RPC
 * `landlord_ops_float_overview()`; no figure is recomputed on the client and
 * nothing is written.
 */
export interface LandlordFloatOverview {
  as_at: string;
  needed: {
    empty_houses: { houses: number; amount: number };
    waiting_funding: { houses: number; amount: number };
    total_amount: number;
    total_houses: number;
    by_district: Array<{ district: string; houses: number; amount: number }>;
    waiting_rows: Array<{
      rent_request_id: string;
      tenant_name: string;
      landlord_name: string;
      landlord_phone: string | null;
      district: string;
      status: string;
      amount: number;
      created_at: string;
    }>;
  };
  collecting: {
    paid_out: { payouts: number; amount: number };
    paid_all_time: { payouts: number; amount: number };
    expected: { plans: number; expected: number; collected: number; contracted: number };
    rows: Array<{
      rent_request_id: string;
      tenant_name: string;
      landlord_name: string;
      landlord_phone: string | null;
      rent_amount: number;
      contracted: number;
      collected: number;
      outstanding: number;
      daily_repayment: number;
      status: string;
      funded_at: string | null;
    }>;
  };
  with_agents: {
    summary: { agents: number; amount: number; total_funded: number; total_paid_out: number };
    rows: Array<{
      agent_id: string;
      agent_name: string;
      agent_phone: string | null;
      region: string | null;
      balance: number;
      total_funded: number;
      total_paid_out: number;
      updated_at: string | null;
    }>;
  };
  no_tenant: {
    portfolios: number;
    total: number;
    attached_amount: number;
    attached_houses: number;
    unattached: number;
  };
}

export type LandlordFloatDrilldownKind =
  | 'empty_houses'
  | 'needed_district'
  | 'payouts'
  | 'payouts_all'
  | 'portfolios'
  | 'attached_houses';

/** One row of the geographic float-need breakdown (country/region/district). */
export interface LandlordFloatNeededGeoRow {
  country: string;
  region: string;
  district: string;
  empty_houses: number;
  empty_amount: number;
  waiting_houses: number;
  waiting_amount: number;
  houses: number;
  amount: number;
}

/**
 * Read-only geographic breakdown of the float need. One SECURITY DEFINER RPC
 * (`landlord_ops_float_needed_geo`) groups empty houses and awaiting-funding
 * requests through the approved country -> region -> district hierarchy;
 * unmatched legacy district text stays under Unmapped, unchanged.
 */
export function useLandlordFloatNeededGeo() {
  return useQuery({
    queryKey: ['landlord-ops-float-needed-geo'],
    staleTime: 60_000,
    queryFn: async (): Promise<LandlordFloatNeededGeoRow[]> => {
      const { data, error } = await (supabase as any).rpc('landlord_ops_float_needed_geo');
      if (error) throw error;
      return ((data as any)?.rows ?? []) as LandlordFloatNeededGeoRow[];
    },
  });
}

/** One approved Uganda district, used by the Unmapped mapping picker. */
export interface ApprovedDistrict {
  id: number;
  name: string;
  region: string | null;
}

/** Existing mapping state for a recorded district spelling. */
export interface DistrictAliasStatus {
  normalisable: boolean;
  norm_key?: string;
  approved?: { district_id: number; district_name: string; region: string | null } | null;
  override?: {
    district_id: number;
    district_name: string;
    region: string | null;
    reason: string;
    mapped_at: string;
  } | null;
}

/**
 * Read-only check of whether a recorded spelling already resolves to an approved
 * district or already carries an operator mapping. Used to warn before a
 * conflicting mapping is attempted; the server refuses conflicts regardless.
 */
export function useDistrictAliasStatus(recordedText: string | null) {
  return useQuery({
    queryKey: ['landlord-ops-district-alias-status', recordedText],
    enabled: !!recordedText,
    staleTime: 60_000,
    queryFn: async (): Promise<DistrictAliasStatus> => {
      const { data, error } = await (supabase as any).rpc('landlord_ops_district_alias_status', {
        p_recorded_text: recordedText,
      });
      if (error) throw error;
      return (data ?? { normalisable: false }) as DistrictAliasStatus;
    },
  });
}

/** Read-only list of approved districts (`landlord_ops_approved_districts`). */
export function useApprovedDistricts(enabled = true) {
  return useQuery({
    queryKey: ['landlord-ops-approved-districts'],
    enabled,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<ApprovedDistrict[]> => {
      const { data, error } = await (supabase as any).rpc('landlord_ops_approved_districts');
      if (error) throw error;
      return ((data as any)?.rows ?? []) as ApprovedDistrict[];
    },
  });
}

/**
 * One-click mapping of an unmatched (legacy) district spelling to an approved
 * district. The RPC `landlord_ops_map_district_alias` only records an alias —
 * the spelling recorded on any house, landlord or tenant record is never
 * rewritten. On success every landlord-float query is refreshed so the mapped
 * rows leave Unmapped immediately.
 */
export function useMapDistrictAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { recordedText: string; districtId: number; reason: string }) => {
      const { data, error } = await (supabase as any).rpc('landlord_ops_map_district_alias', {
        p_recorded_text: vars.recordedText,
        p_district_id: vars.districtId,
        p_reason: vars.reason,
      });
      if (error) throw error;
      return data as { district_name: string; region: string | null };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['landlord-ops-float-needed-geo'] });
      qc.invalidateQueries({ queryKey: ['landlord-ops-float-overview'] });
      qc.invalidateQueries({ queryKey: ['landlord-ops-float-drilldown'] });
      qc.invalidateQueries({ queryKey: ['landlord-ops-float-needed-district'] });
    },
  });
}

/**
 * Read-only drill-down rows behind a Landlord Float total. One SECURITY DEFINER
 * RPC does all the reading; nothing is written and no figure is recomputed on
 * the client. District-scoped float need uses the alias-aware RPC so mapped
 * spellings stay consistent with the geographic summary.
 */
export function useLandlordFloatDrilldown(
  kind: LandlordFloatDrilldownKind | null,
  key?: string | null,
) {
  const isDistrict = kind === 'needed_district';
  return useQuery({
    queryKey: isDistrict
      ? ['landlord-ops-float-needed-district', key ?? null]
      : ['landlord-ops-float-drilldown', kind, key ?? null],
    enabled: !!kind,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, any>[]> => {
      if (isDistrict) {
        const { data, error } = await (supabase as any).rpc(
          'landlord_ops_float_needed_district_rows',
          { p_key: key ?? null },
        );
        if (error) throw error;
        return ((data as any)?.rows ?? []) as Record<string, any>[];
      }
      const { data, error } = await (supabase as any).rpc('landlord_ops_float_drilldown', {
        p_kind: kind,
        p_key: key ?? null,
      });
      if (error) throw error;
      return ((data as any)?.rows ?? []) as Record<string, any>[];
    },

  });
}

export function useLandlordFloatOverview() {
  return useQuery({
    queryKey: ['landlord-ops-float-overview'],
    queryFn: async (): Promise<LandlordFloatOverview> => {
      const { data, error } = await (supabase as any).rpc('landlord_ops_float_overview');
      if (error) throw error;
      return data as LandlordFloatOverview;
    },
    staleTime: 60_000,
  });
}

/** One page of the landlord payout register, read straight from the RPC. */
export interface LandlordPayoutsPage {
  rows: Array<{
    id: string;
    landlord_name: string;
    landlord_phone: string | null;
    tenant_name: string | null;
    agent_name: string | null;
    amount: number;
    provider: string | null;
    reference: string | null;
    status: string;
    disbursed_at: string | null;
    created_at: string;
    country: string;
    region: string;
    district: string;
    recorded_district: string | null;
    sub_county: string | null;
    village: string | null;
  }>;
  total_count: number;
  total_amount: number;
  limit: number;
  offset: number;
  as_at: string;
}

export interface LandlordPayoutsPageArgs {
  scope: 'all_time' | 'completed';
  search?: string;
  from?: string | null;
  to?: string | null;
  agentId?: string | null;
  page: number;
  pageSize: number;
  /** Server-side sort column key (defaults to the payment date). */
  sort?: string;
  dir?: 'asc' | 'desc';
  /** Geography filters, resolved server-side through the approved hierarchy. */
  country?: string | null;
  region?: string | null;
  district?: string | null;
}

/** One country/region/district row of the landlord payout geography. */
export interface LandlordPayoutsGeoRow {
  country: string;
  region: string;
  district: string;
  payouts: number;
  amount: number;
  unmatched: boolean;
}

/**
 * Read-only geographic breakdown of money paid to landlords. The RPC
 * `landlord_ops_payouts_geo` groups the same payout population as the register
 * through the approved country -> region -> district hierarchy; recorded
 * location text is never rewritten and unmatched spellings stay under Unmapped.
 */
export function useLandlordPayoutsGeo(
  args: {
    scope: 'all_time' | 'completed';
    search?: string;
    from?: string | null;
    to?: string | null;
    agentId?: string | null;
  },
  enabled = true,
) {
  const { scope, search, from, to, agentId } = args;
  return useQuery({
    queryKey: [
      'landlord-ops-payouts-geo',
      scope,
      search ?? '',
      from ?? '',
      to ?? '',
      agentId ?? '',
    ],
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<LandlordPayoutsGeoRow[]> => {
      const { data, error } = await (supabase as any).rpc('landlord_ops_payouts_geo', {
        p_scope: scope,
        p_search: search?.trim() ? search.trim() : null,
        p_from: from || null,
        p_to: to || null,
        p_agent_id: agentId || null,
      });
      if (error) throw error;
      return ((data as any)?.rows ?? []) as LandlordPayoutsGeoRow[];
    },
  });
}

/**
 * Server-side paginated, searchable landlord payout register. Counting,
 * filtering, searching and totalling all happen in
 * `landlord_ops_payouts_page`, so the register carries millions of payouts
 * without ever loading them into the browser. Read-only.
 */
export function useLandlordPayoutsPage(args: LandlordPayoutsPageArgs, enabled = true) {
  const { scope, search, from, to, agentId, page, pageSize, sort, dir, country, region, district } =
    args;
  return useQuery({
    queryKey: [
      'landlord-ops-payouts-page',
      scope,
      search ?? '',
      from ?? '',
      to ?? '',
      agentId ?? '',
      page,
      pageSize,
      sort ?? 'disbursed_at',
      dir ?? 'desc',
      country ?? '',
      region ?? '',
      district ?? '',
    ],
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<LandlordPayoutsPage> => {
      const { data, error } = await (supabase as any).rpc('landlord_ops_payouts_page', {
        p_scope: scope,
        p_search: search?.trim() ? search.trim() : null,
        p_from: from || null,
        p_to: to || null,
        p_agent_id: agentId || null,
        p_limit: pageSize,
        p_offset: Math.max(0, (page - 1) * pageSize),
        p_sort: sort ?? 'disbursed_at',
        p_dir: dir ?? 'desc',
      });
      if (error) throw error;
      return data as LandlordPayoutsPage;
    },
  });
}
