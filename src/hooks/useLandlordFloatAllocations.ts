import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export type LandlordFloatAllocation = {
  id: string;
  agent_id: string;
  tenant_id: string | null;
  rent_request_id: string | null;
  landlord_id: string | null;
  landlord_name: string;
  landlord_phone: string | null;
  mobile_money_provider: string | null;
  allocated_amount: number;
  paid_out_amount: number;
  remaining_amount: number;
  status: 'open' | 'partially_paid' | 'fully_paid' | 'cancelled';
  source: string;
  created_at: string;
  /** Tenant this earmark pays a landlord FOR — used so agents can find the row by tenant. */
  tenant_name: string | null;
};

/**
 * Fetches the agent's per-tenant landlord float allocations.
 * Each row represents one CFO disbursement targeted at a specific tenant→landlord pair.
 * Used by the agent payout flow to drill from "total float" → "tenant" → "withdraw".
 */
export function useLandlordFloatAllocations(opts?: { onlyOpen?: boolean }) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['landlord-float-allocations', user?.id, opts?.onlyOpen ?? true],
    queryFn: async (): Promise<LandlordFloatAllocation[]> => {
      if (!user) return [];
      let q = supabase
        .from('agent_landlord_float_allocations' as any)
        .select('*')
        .eq('agent_id', user.id)
        .order('created_at', { ascending: false })
        .limit(200);
      if (opts?.onlyOpen !== false) {
        q = q.in('status', ['open', 'partially_paid']);
      }
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as any[];

      // The allocation row stores a NAME SNAPSHOT taken at disbursement time.
      // If the landlord record is later edited/merged (name or MoMo number
      // changed), that snapshot goes stale and the agent sees an unrecognizable
      // name in the payout list ("why isn't my tenant here?"). Re-hydrate the
      // landlord name/phone from the live record, and attach the tenant name so
      // the agent can identify the payout by the tenant it belongs to.
      const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))];
      const landlordIds = [...new Set(rows.map((r) => r.landlord_id).filter(Boolean))];

      const [tenantsRes, landlordsRes] = await Promise.all([
        tenantIds.length
          ? supabase.from('profiles').select('id, full_name').in('id', tenantIds)
          : Promise.resolve({ data: [] as any[] }),
        landlordIds.length
          ? supabase
              .from('landlords')
              .select('id, name, mobile_money_number, phone')
              .in('id', landlordIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const tenantById = new Map<string, string>(
        ((tenantsRes as any).data ?? []).map((t: any) => [t.id, t.full_name]),
      );
      const landlordById = new Map<string, any>(
        ((landlordsRes as any).data ?? []).map((l: any) => [l.id, l]),
      );

      return rows.map((r) => {
        const live = r.landlord_id ? landlordById.get(r.landlord_id) : null;
        return {
          ...r,
          landlord_name: live?.name || r.landlord_name,
          landlord_phone: live?.mobile_money_number || live?.phone || r.landlord_phone,
          tenant_name: r.tenant_id ? tenantById.get(r.tenant_id) ?? null : null,
          allocated_amount: Number(r.allocated_amount) || 0,
          paid_out_amount: Number(r.paid_out_amount) || 0,
          remaining_amount: Number(r.remaining_amount) || 0,
        };
      }) as LandlordFloatAllocation[];
    },
    enabled: !!user,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}
