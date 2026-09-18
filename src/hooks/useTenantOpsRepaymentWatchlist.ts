import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Read-only repayment watchlist for Tenant Ops → Classic → Home.
 *
 * Every figure comes from the existing authoritative sources, aggregated
 * server-side by `get_tenant_ops_repayment_watchlist()` (one round trip, no
 * N+1): active plans from `v_tenant_ops_tenant_base.is_active`, arrears from
 * `arrears_amount`, ahead-of-schedule from `advance_amount`, term end from
 * `v_rent_plan_schedule.term_end`, last payment from `last_payment_at`
 * (`agent_collections`), and daily vs weekly from the same `repayment_frequency`
 * / `rent_request_is_weekly_shape` rule `v_agent_daily_eligibility` uses.
 * No repayment rule is re-derived on the client.
 */
export type WatchlistBucketKey = 'overdue' | 'daily_behind' | 'weekly_behind' | 'advance';

export interface WatchlistAgentRow {
  agent_id: string | null;
  label: string;
  tenants: number;
  amount: number;
  avg_days_since_pay: number | null;
  max_days_past_end: number | null;
}

export interface WatchlistBucket {
  tenants: number;
  amount: number;
  agents: WatchlistAgentRow[];
}

export interface TenantOpsRepaymentWatchlist {
  as_of: string | null;
  buckets: Partial<Record<WatchlistBucketKey, WatchlistBucket>>;
}

const EMPTY_BUCKET: WatchlistBucket = { tenants: 0, amount: 0, agents: [] };

export function useTenantOpsRepaymentWatchlist(enabled: boolean = true) {
  return useQuery({
    queryKey: ['tenant-ops-repayment-watchlist'],
    enabled,
    staleTime: 120000,
    refetchInterval: 180000,
    queryFn: async (): Promise<TenantOpsRepaymentWatchlist> => {
      const { data, error } = await supabase.rpc('get_tenant_ops_repayment_watchlist');
      if (error) throw error;
      const raw = (data ?? {}) as {
        as_of?: string;
        buckets?: Partial<Record<WatchlistBucketKey, Partial<WatchlistBucket>>>;
      };
      const buckets: Partial<Record<WatchlistBucketKey, WatchlistBucket>> = {};
      (['overdue', 'daily_behind', 'weekly_behind', 'advance'] as WatchlistBucketKey[]).forEach((k) => {
        const b = raw.buckets?.[k];
        buckets[k] = b
          ? {
              tenants: Number(b.tenants ?? 0),
              amount: Number(b.amount ?? 0),
              agents: (b.agents ?? []).map((a) => ({
                agent_id: a.agent_id ?? null,
                label: a.label ?? 'Unassigned',
                tenants: Number(a.tenants ?? 0),
                amount: Number(a.amount ?? 0),
                avg_days_since_pay: a.avg_days_since_pay == null ? null : Number(a.avg_days_since_pay),
                max_days_past_end: a.max_days_past_end == null ? null : Number(a.max_days_past_end),
              })),
            }
          : EMPTY_BUCKET;
      });
      return { as_of: raw.as_of ?? null, buckets };
    },
  });
}
