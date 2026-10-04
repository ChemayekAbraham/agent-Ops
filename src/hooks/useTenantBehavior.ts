import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantBehaviorPayload {
  header: {
    tenant_id: string;
    full_name: string | null;
    phone: string | null;
    city: string | null;
    verified: boolean;
    trust_score: number;
    trust_tier: string | null;
    borrowing_limit_ugx: number;
  };
  trend_30d: Array<{ d: string; paid: number }>;
  cohort: { city: string | null; tenant_paid_30d: number };
  trust_breakdown: Record<string, unknown>;
  recent_events: Array<{ id: string; event_type: string; created_at: string; metadata: unknown }>;
}

export function useTenantBehavior(tenantId: string | null) {
  return useQuery({
    enabled: !!tenantId,
    queryKey: ['tenant-behavior', tenantId],
    queryFn: async () => {
      if (!tenantId) return null;
      const { data, error } = await supabase.rpc('ops_tenant_behavior', { p_tenant_id: tenantId });
      if (error) throw error;
      return data as unknown as TenantBehaviorPayload;
    },
    staleTime: 60_000,
  });
}
