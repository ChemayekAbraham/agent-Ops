import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Rent-request statuses that mean a tenant has genuinely done business with us
 * before. A tenant with at least one such plan (other than the request under
 * review) is "Renewing"; anyone else is "New".
 *
 * Mirrors the server definition in `rent_pipeline_tenant_history`.
 */
export const RENEWAL_QUALIFYING_STATUSES = ['coo_approved', 'funded', 'repaying', 'completed'] as const;

export type TenantRelationship = 'new' | 'renewing';

export interface TenantRelationshipInfo {
  /** Number of prior approved/funded/completed rent plans. */
  approvedPlans: number;
  relationship: TenantRelationship;
}

/**
 * Batch "New / Renewing" classification for every tenant visible in a queue.
 * Presentation only — never used for eligibility or money logic.
 *
 * @param tenantIds   tenants shown in the list
 * @param excludeIds  request ids currently in the list; excluded so a tenant's
 *                    own in-flight request never counts as a prior plan
 */
export function useTenantRenewalMap(tenantIds: string[], excludeIds: string[] = []) {
  const tenantKey = Array.from(new Set(tenantIds.filter(Boolean))).sort();
  const excludeKey = Array.from(new Set(excludeIds.filter(Boolean))).sort();

  return useQuery({
    queryKey: ['tenant-renewal-map', tenantKey.join(','), excludeKey.join(',')],
    enabled: tenantKey.length > 0,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const counts = new Map<string, number>();
      const exclude = new Set(excludeKey);
      const chunkSize = 300;
      for (let i = 0; i < tenantKey.length; i += chunkSize) {
        const chunk = tenantKey.slice(i, i + chunkSize);
        const { data, error } = await supabase
          .from('rent_requests')
          .select('id, tenant_id')
          .in('tenant_id', chunk)
          .in('status', [...RENEWAL_QUALIFYING_STATUSES])
          .limit(5000);
        if (error) throw error;
        (data || []).forEach(row => {
          if (!row.tenant_id || exclude.has(row.id)) return;
          counts.set(row.tenant_id, (counts.get(row.tenant_id) || 0) + 1);
        });
      }
      const map = new Map<string, TenantRelationshipInfo>();
      tenantKey.forEach(id => {
        const approvedPlans = counts.get(id) || 0;
        map.set(id, { approvedPlans, relationship: approvedPlans > 0 ? 'renewing' : 'new' });
      });
      return map;
    },
  });
}
