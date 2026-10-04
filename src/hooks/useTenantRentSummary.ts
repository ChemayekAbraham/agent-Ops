import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface TenantRentSummary {
  outstandingBalance: number;
  totalObligation: number;
  totalRepaid: number;
  activePlanCount: number;
  latestRequestId: string | null;
  latestStatus: string | null;
  latestRegistrationType: string | null;
  latestDailyRepayment: number;
  latestCreatedAt: string | null;
  previousAgentId: string | null;
  previousAgentName: string | null;
  previousAgentPhone: string | null;
}

/**
 * Fetches a security-definer summary of an already-registered tenant so an agent
 * (even one who did NOT register them) can see the tenant's current outstanding
 * balance and the previous/collecting agent before deciding to renew — instead
 * of creating a duplicate rent plan.
 */
export function useTenantRentSummary(tenantId: string | null | undefined) {
  const [summary, setSummary] = useState<TenantRentSummary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tenantId) {
      setSummary(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_tenant_rent_summary' as any, {
          p_tenant_id: tenantId,
        });
        if (cancelled) return;
        if (error) throw error;
        const row: any = Array.isArray(data) ? data[0] : data;
        if (!row) {
          setSummary(null);
        } else {
          setSummary({
            outstandingBalance: Number(row.outstanding_balance) || 0,
            totalObligation: Number(row.total_obligation) || 0,
            totalRepaid: Number(row.total_repaid) || 0,
            activePlanCount: Number(row.active_plan_count) || 0,
            latestRequestId: row.latest_request_id || null,
            latestStatus: row.latest_status || null,
            latestRegistrationType: row.latest_registration_type || null,
            latestDailyRepayment: Number(row.latest_daily_repayment) || 0,
            latestCreatedAt: row.latest_created_at || null,
            previousAgentId: row.previous_agent_id || null,
            previousAgentName: row.previous_agent_name || null,
            previousAgentPhone: row.previous_agent_phone || null,
          });
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[useTenantRentSummary] lookup failed', err);
          setSummary(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  return { summary, loading };
}
