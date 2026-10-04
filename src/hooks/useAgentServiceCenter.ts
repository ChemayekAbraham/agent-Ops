import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/** Cross-runtime escape hatch: these RPCs are newer than the generated types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface ServiceCenterTenant {
  rent_request_id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone?: string | null;
  status: string;
  monthly_rent: number | null;
  total_repayment?: number | null;
  amount_repaid?: number | null;
  /**
   * Live agent collections on this plan, all time, reversals excluded.
   * This is the receipt book: what an agent actually took in. It is NOT
   * `amount_repaid`, which is the plan balance and has many writers.
   */
  collected_live?: number | null;
  daily_repayment?: number | null;
  landlord_name?: string | null;
  landlord_phone?: string | null;
  location?: string | null;
  /** True only for funded/repaying rent plans; transfers are limited to these. */
  is_active?: boolean;
  /** True when the rent plan itself belongs to this sub-agent (not just a referral). */
  owned_by_subagent?: boolean;
  created_at?: string | null;
}

export type ServiceCenterState = 'verified' | 'pending' | 'rejected';

export interface ServiceCenterHouse {
  id: string;
  title: string | null;
  address: string | null;
  district: string | null;
  region: string | null;
  monthly_rent: number | null;
  state: ServiceCenterState;
  status: string | null;
  occupied: boolean;
  reason: string | null;
  photos?: string[];
  photo_count?: number;
  verified_at: string | null;
  created_at: string | null;
}

export interface ServiceCenterLandlord {
  id: string;
  name: string | null;
  phone: string | null;
  district: string | null;
  region: string | null;
  address?: string | null;
  village?: string | null;
  county?: string | null;
  state: ServiceCenterState;
  link_source: string | null;
  reason: string | null;
  verified_at: string | null;
  created_at: string | null;
}

export interface ServiceCenterSubAgent {
  sub_agent_id: string;
  full_name: string | null;
  avatar_url: string | null;
  phone: string | null;
  email: string | null;
  agent_tier: string | null;
  link_status: string;
  linked_at: string | null;
  source: string | null;
  commission_total: number;
  referral_bonus: number;
  active_tenants: number;
  total_tenants: number;
  tenant_list: ServiceCenterTenant[];
  nested_subagents: number;
  landlords_registered: number;
  landlords_verified: number;
  landlords_pending?: number;
  landlords_rejected?: number;
  landlord_list?: ServiceCenterLandlord[];
  houses_listed?: number;
  houses_verified?: number;
  houses_pending?: number;
  houses_rejected?: number;
  house_list?: ServiceCenterHouse[];
  wallet: { withdrawable: number; float: number; advance: number };
  suspension: { blocked_until: string | null; reason: string | null; scope: string | null } | null;
  pending_transfers: number;
}

export interface ServiceCenterOverview {
  parent_agent_id: string;
  generated_at?: string;
  sub_agents: ServiceCenterSubAgent[];
}

export interface TenantTransferRow {
  id: string;
  rent_request_id: string;
  tenant_name: string | null;
  from_name: string | null;
  to_name: string | null;
  reason: string;
  status: string;
  requested_at: string;
  decided_at: string | null;
  decision_reason: string | null;
}

export interface CatalogItem {
  id: string;
  item_name: string;
  description: string | null;
  unit_price: number;
  image_url: string | null;
  image_urls: string[] | null;
}


/** One round trip for the whole roster (profiles, earnings, tenants, wallets, blocks). */
export function useServiceCenterOverview() {
  return useQuery<ServiceCenterOverview>({
    queryKey: ['agent-service-center'],
    queryFn: async () => {
      const { data, error } = await db.rpc('get_agent_service_center');
      if (error) throw error;
      const raw = (data as (ServiceCenterOverview & { sub_agents?: (ServiceCenterSubAgent & { name?: string | null })[] }) | null) ?? null;
      if (!raw) return { parent_agent_id: '', sub_agents: [] };
      const seen = new Set<string>();
      const rows = (raw.sub_agents ?? []).filter((s) => {
        // Defensive de-duplication: a sub-agent with two link rows or two active
        // freezes must still render exactly one card.
        const id = (s as ServiceCenterSubAgent).sub_agent_id;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      }).map((s) => {
        const row = s as ServiceCenterSubAgent & { name?: string | null };
        // The RPC emits the display name as `name`; the UI reads `full_name`.
        // Fall back to phone/email so an incomplete profile never renders as
        // "Unnamed sub-agent", and always guarantee a wallet object so the
        // detail sheet can open even when balances are missing.
        return {
          ...row,
          full_name: row.full_name ?? row.name ?? row.phone ?? row.email ?? null,
          wallet: row.wallet ?? { withdrawable: 0, float: 0, advance: 0 },
          nested_subagents: row.nested_subagents ?? 0,
          // The RPC emits the freeze scope as `freeze_scope`.
          suspension: row.suspension
            ? {
                ...row.suspension,
                scope:
                  row.suspension.scope ??
                  (row.suspension as unknown as { freeze_scope?: string | null }).freeze_scope ??
                  null,
              }
            : null,
          // The RPC emits tenants with `id`/`name`; the UI reads
          // `tenant_id`/`tenant_name`. Normalise so tenant KPIs and lists are
          // never blank.
          tenant_list: (row.tenant_list ?? []).map((t) => {
            const raw = t as ServiceCenterTenant & { id?: string | null; name?: string | null; phone?: string | null };
            return {
              ...raw,
              tenant_id: raw.tenant_id ?? raw.id ?? null,
              tenant_name: raw.tenant_name ?? raw.name ?? null,
              tenant_phone: raw.tenant_phone ?? raw.phone ?? null,
            };
          }),
        };
      });

      return { ...raw, sub_agents: rows };
    },
    staleTime: 60_000,
  });
}

export function useServiceCenterTransfers() {
  return useQuery<TenantTransferRow[]>({
    queryKey: ['agent-service-center-transfers'],
    queryFn: async () => {
      const { data, error } = await db.rpc('agent_list_subagent_tenant_transfers', { p_limit: 50 });
      if (error) throw error;
      return (data as TenantTransferRow[]) ?? [];
    },
    staleTime: 60_000,
  });
}

export function useServiceCenterCatalog() {
  return useQuery<CatalogItem[]>({
    queryKey: ['merchandise-catalog'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('merchandise_catalog')
        .select('id, item_name, description, unit_price, image_url, image_urls')
        .eq('is_active', true)

        .order('item_name');
      if (error) throw error;
      return (data as CatalogItem[]) ?? [];
    },
    staleTime: 5 * 60_000,
  });
}

function useInvalidateServiceCenter() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['agent-service-center'] });
    qc.invalidateQueries({ queryKey: ['agent-service-center-transfers'] });
  };
}

export function useSuspendSubAgent() {
  const invalidate = useInvalidateServiceCenter();
  return useMutation({
    mutationFn: async (vars: { subAgentId: string; days: number; reason: string }) => {
      const { data, error } = await db.rpc('agent_suspend_subagent', {
        p_sub_agent_id: vars.subAgentId,
        p_days: vars.days,
        p_reason: vars.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useRestoreSubAgent() {
  const invalidate = useInvalidateServiceCenter();
  return useMutation({
    mutationFn: async (vars: { subAgentId: string; reason: string }) => {
      const { data, error } = await db.rpc('agent_restore_subagent', {
        p_sub_agent_id: vars.subAgentId,
        p_reason: vars.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useRequestTenantTransfer() {
  const invalidate = useInvalidateServiceCenter();
  return useMutation({
    mutationFn: async (vars: { rentRequestId: string; toSubAgentId: string; reason: string }) => {
      const { data, error } = await db.rpc('agent_request_subagent_tenant_transfer', {
        p_rent_request_id: vars.rentRequestId,
        p_to_sub_agent_id: vars.toSubAgentId,
        p_reason: vars.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

/** Break the parent ↔ sub-agent relationship (archived server-side, reason required). */
export function useUnlinkSubAgent() {
  const invalidate = useInvalidateServiceCenter();
  return useMutation({
    mutationFn: async (vars: { subAgentId: string; reason: string }) => {
      const { data, error } = await db.rpc('agent_unlink_subagent', {
        p_sub_agent_id: vars.subAgentId,
        p_reason: vars.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}