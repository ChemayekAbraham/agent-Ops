import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantEngagementRow {
  tenant_id: string;
  full_name: string | null;
  phone: string | null;
  has_smartphone: boolean;
  last_active_at: string | null;
  tenant_status: string | null;
  days_since_active: number | null;
}

export interface TenantEngagementSummary {
  tenants: number;
  with_smartphone: number;
  without_smartphone: number;
  never_active: number;
  inactive_30d: number;
  generated_at: string;
}

/**
 * Cross-references profiles.has_smartphone with profiles.last_active_at so
 * Tenant Ops can see who owns a smartphone but isn't using their dashboard —
 * the gap flagged in the 2026-09-06 tenant-ops meeting. Both source columns
 * already exist and are maintained elsewhere; this just reports on them.
 */
export function useTenantEngagementReport(search = '', limit = 200) {
  return useQuery({
    queryKey: ['tenant-engagement-report', search, limit],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_tenant_engagement_report' as any, {
        p_limit: limit,
        p_offset: 0,
        p_search: search || null,
      });
      if (error) throw error;
      const payload = (data ?? {}) as { summary?: TenantEngagementSummary; rows?: TenantEngagementRow[] };
      return {
        summary: payload.summary ?? {
          tenants: 0,
          with_smartphone: 0,
          without_smartphone: 0,
          never_active: 0,
          inactive_30d: 0,
          generated_at: new Date().toISOString(),
        },
        rows: payload.rows ?? [],
      };
    },
    staleTime: 120_000,
  });
}
