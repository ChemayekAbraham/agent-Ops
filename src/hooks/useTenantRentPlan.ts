import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantRentPlanRow {
  id: string;
  status: 'repaying' | 'completed' | 'paused' | 'defaulted' | string;
  total_amount: number;
  amount_repaid: number;
  outstanding: number;
  daily_amount: number;
  term_days: number;
  term_start: string;
  term_end: string;
  obligation_end: string;
  days_elapsed: number;
  behaviour_score: number;
  house_name: string;
  agent_name: string;
  due_now: number;
}

export interface TenantRentPlanPayload {
  plan: TenantRentPlanRow | null;
  walletBalance: number;
  recentPayments: { date: string; amount: number; method: string }[];
}

const EMPTY: TenantRentPlanPayload = { plan: null, walletBalance: 0, recentPayments: [] };

/** Reads the signed-in tenant's own active Rent Plan (server-side, self only). */
export function useTenantRentPlan(enabled = true) {
  return useQuery<TenantRentPlanPayload>({
    queryKey: ['tenant-rent-plan'],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('tenant_rent_plan_detail' as any);
      if (error) throw error;
      const raw: any = data ?? {};
      const plan = raw.plan
        ? {
            ...raw.plan,
            total_amount: Number(raw.plan.total_amount) || 0,
            amount_repaid: Number(raw.plan.amount_repaid) || 0,
            outstanding: Number(raw.plan.outstanding) || 0,
            daily_amount: Number(raw.plan.daily_amount) || 0,
            term_days: Number(raw.plan.term_days) || 0,
            days_elapsed: Number(raw.plan.days_elapsed) || 0,
            behaviour_score: Number(raw.plan.behaviour_score) || 0,
            due_now: Number(raw.plan.due_now) || 0,
          }
        : null;
      if (!plan) return EMPTY;
      return {
        plan,
        walletBalance: Number(raw.wallet_balance) || 0,
        recentPayments: Array.isArray(raw.recent_payments)
          ? raw.recent_payments.map((p: any) => ({
              date: p.date,
              amount: Number(p.amount) || 0,
              method: p.method || 'Payment',
            }))
          : [],
      };
    },
  });
}

export interface PayRentResult {
  amount_paid: number;
  remaining_balance: number;
  new_wallet_balance: number;
  reference: string;
}

/**
 * Pays rent from the tenant's wallet. All money movement happens inside the
 * `tenant-pay-rent` edge function (ledger legs + repayment record + commission).
 */
export function usePayRentFromWallet() {
  const qc = useQueryClient();
  return useMutation<PayRentResult, Error, number>({
    mutationFn: async (amount: number) => {
      const { data, error } = await supabase.functions.invoke('tenant-pay-rent', {
        body: { amount },
      });
      if (error) {
        const detail = (data as any)?.error;
        throw new Error(detail || error.message || 'Payment failed');
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as PayRentResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-rent-plan'] });
      qc.invalidateQueries({ queryKey: ['wallet'] });
      qc.invalidateQueries({ queryKey: ['wallet-balance'] });
      qc.invalidateQueries({ queryKey: ['repayments'] });
    },
  });
}
