import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ServiceCenterAdvancePlan {
  id: string; item_name: string; category: string | null;
  holder_id: string; holder_name: string | null; holder_phone: string | null; is_self: boolean;
  original_amount: number; repaid: number; outstanding: number; daily: number;
  due_balance: number; surcharge: number; starts_on: string | null; term_end_on: string | null;
  last_paid_at: string | null; on_hold: boolean; paid_7d: number; pct: number;
  recent: { amount: number; at: string; outstanding_after: number }[];
}
export interface ServiceCenterAdvances {
  centre_name: string | null; manager_name: string | null; plans: ServiceCenterAdvancePlan[];
  totals: { original: number; repaid: number; outstanding: number; daily: number; paid7d: number; due: number; pct: number };
}

const pctOf = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);

/** One round trip; the server scopes rows to the caller and their verified sub-agents. */
export function useServiceCenterAdvances(enabled = true) {
  return useQuery({
    queryKey: ['service-center-active-advances'],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<ServiceCenterAdvances> => {
      const { data, error } = await supabase.rpc('get_service_center_active_advances' as any);
      if (error) throw error;
      const raw = (data ?? {}) as any;
      const plans: ServiceCenterAdvancePlan[] = (raw.plans ?? []).map((p: any) => {
        const original = Number(p.original_amount) || 0, repaid = Number(p.repaid) || 0;
        return {
          ...p, original_amount: original, repaid, outstanding: Number(p.outstanding) || 0,
          daily: Number(p.daily) || 0, due_balance: Number(p.due_balance) || 0, paid_7d: Number(p.paid_7d) || 0,
          pct: pctOf(repaid, original), recent: p.recent ?? [],
        };
      });
      const sum = (k: keyof ServiceCenterAdvancePlan) => plans.reduce((s, p) => s + (Number(p[k]) || 0), 0);
      const original = sum('original_amount'), repaid = sum('repaid');
      return {
        centre_name: raw.centre_name ?? null, manager_name: raw.manager_name ?? null, plans,
        totals: { original, repaid, outstanding: sum('outstanding'), daily: sum('daily'), paid7d: sum('paid_7d'), due: sum('due_balance'), pct: pctOf(repaid, original) },
      };
    },
  });
}
