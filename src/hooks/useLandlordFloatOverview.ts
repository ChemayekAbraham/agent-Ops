import { useQuery } from '@tanstack/react-query';
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
  | 'payouts'
  | 'portfolios'
  | 'attached_houses';

/**
 * Read-only drill-down rows behind a Landlord Float total. One SECURITY DEFINER
 * RPC (`landlord_ops_float_drilldown`) does all the reading; nothing is written
 * and no figure is recomputed on the client.
 */
export function useLandlordFloatDrilldown(
  kind: LandlordFloatDrilldownKind | null,
  key?: string | null,
) {
  return useQuery({
    queryKey: ['landlord-ops-float-drilldown', kind, key ?? null],
    enabled: !!kind,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, any>[]> => {
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
