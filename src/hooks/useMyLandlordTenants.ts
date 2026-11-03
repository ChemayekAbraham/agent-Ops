import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/** One Rent Plan, as returned by get_my_landlord_tenants(). */
export interface LandlordTenantPlan {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  status: string;
  tenancy_status: string | null;
  rent_amount: number;
  duration_days: number | null;
  created_at: string;
  funded_at: string | null;
  starts_on: string | null;
  ends_on: string | null;
  progress_pct: number;
  property_address: string | null;
  house_category: string | null;
}

export type PlanPhase = 'active' | 'in_review' | 'completed' | 'ended';

export interface LandlordTenant {
  tenantId: string;
  name: string;
  phone: string | null;
  property: string | null;
  /** Newest Rent Plan first. */
  plans: LandlordTenantPlan[];
  latest: LandlordTenantPlan;
}

export function planPhase(plan: Pick<LandlordTenantPlan, 'status' | 'tenancy_status'>): PlanPhase {
  if (plan.tenancy_status === 'terminated') return 'ended';
  if (plan.status === 'completed') return 'completed';
  if (plan.status === 'repaying' || plan.status === 'funded') return 'active';
  return 'in_review';
}

export const PLAN_PHASE_LABEL: Record<PlanPhase, string> = {
  active: 'Active',
  in_review: 'In review',
  completed: 'Completed',
  ended: 'Tenancy ended',
};

interface RpcResult {
  matched_by_phone: boolean;
  landlord_records?: number;
  plans: LandlordTenantPlan[];
}

/** The signed-in landlord's tenants and their Rent Plans (matched to the landlord record by phone). */
export function useMyLandlordTenants() {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ['my-landlord-tenants', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async (): Promise<RpcResult> => {
      // The function is newer than the generated database types, so call it through a narrow cast.
      const rpc = supabase as unknown as { rpc: (fn: string) => Promise<{ data: unknown; error: Error | null }> };
      const { data, error } = await rpc.rpc('get_my_landlord_tenants');
      if (error) throw error;
      const d = (data ?? {}) as Partial<RpcResult>;
      return {
        matched_by_phone: !!d.matched_by_phone,
        landlord_records: d.landlord_records ?? 0,
        plans: d.plans ?? [],
      };
    },
  });

  const tenants = useMemo<LandlordTenant[]>(() => {
    const byTenant = new Map<string, LandlordTenantPlan[]>();
    for (const p of query.data?.plans ?? []) {
      const list = byTenant.get(p.tenant_id) ?? [];
      list.push(p);
      byTenant.set(p.tenant_id, list);
    }
    return Array.from(byTenant.values())
      .map((plans) => {
        const latest = plans[0];
        return {
          tenantId: latest.tenant_id,
          name: latest.tenant_name,
          phone: latest.tenant_phone,
          property: latest.property_address,
          plans,
          latest,
        };
      })
      // Tenants with a running Rent Plan first, then by newest plan.
      .sort((a, b) => {
        const rank = (t: LandlordTenant) => (planPhase(t.latest) === 'active' ? 0 : planPhase(t.latest) === 'in_review' ? 1 : 2);
        return rank(a) - rank(b);
      });
  }, [query.data]);

  const counts = useMemo(() => {
    const plans = query.data?.plans ?? [];
    return {
      tenants: tenants.length,
      active: plans.filter((p) => planPhase(p) === 'active').length,
      completed: plans.filter((p) => planPhase(p) === 'completed').length,
    };
  }, [query.data, tenants.length]);

  return {
    tenants,
    counts,
    matchedByPhone: query.data?.matched_by_phone ?? true,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
