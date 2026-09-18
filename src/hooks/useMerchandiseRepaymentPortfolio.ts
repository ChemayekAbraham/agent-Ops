import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const db = supabase as any;

export interface MerchandiseRepaymentPlan {
  id: string;
  sale_id: string | null;
  item_name: string | null;
  original_amount: number;
  outstanding_balance: number;
  amount_recovered: number;
  daily_deduction_amount: number | null;
  daily_rate: number | null;
  starts_on: string | null;
  status: string;
  last_recovery_at: string | null;
  created_at: string;
}

export interface MerchandiseRepaymentDeduction {
  id: string;
  plan_id: string;
  item_name: string | null;
  amount: number;
  outstanding_after: number;
  created_at: string;
}

/**
 * The agent's own merchandise repayment portfolio: every plan they are still
 * paying for, plus the payments already taken off each one.
 *
 * Read-only here. All money movement goes through the SECURITY DEFINER RPC
 * `agent_pay_merchandise_plan` (see `usePayMerchandisePlan`), never a direct
 * wallet or ledger write from the client.
 */
export function useMerchandiseRepaymentPortfolio(userId?: string) {
  const plans = useQuery<MerchandiseRepaymentPlan[]>({
    queryKey: ['merchandise-repayment-plans', userId],
    enabled: !!userId,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_recovery_plans')
        .select(
          'id, sale_id, item_name, original_amount, outstanding_balance, amount_recovered, daily_deduction_amount, daily_rate, starts_on, status, last_recovery_at, created_at',
        )
        .eq('customer_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as MerchandiseRepaymentPlan[];
    },
  });

  const deductions = useQuery<MerchandiseRepaymentDeduction[]>({
    queryKey: ['merchandise-repayment-deductions', userId],
    enabled: !!userId,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_recovery_deductions')
        .select('id, plan_id, item_name, amount, outstanding_after, created_at')
        .eq('customer_id', userId)
        .order('created_at', { ascending: false })
        .limit(60);
      if (error) throw error;
      return (data || []) as MerchandiseRepaymentDeduction[];
    },
  });

  const active = (plans.data ?? []).filter(
    (p) => p.status === 'active' && Number(p.outstanding_balance) > 0,
  );

  return {
    plans: plans.data ?? [],
    activePlans: active,
    deductions: deductions.data ?? [],
    totalOutstanding: active.reduce((s, p) => s + Number(p.outstanding_balance || 0), 0),
    totalPaid: (plans.data ?? []).reduce((s, p) => s + Number(p.amount_recovered || 0), 0),
    isLoading: plans.isLoading,
    refetch: () => {
      plans.refetch();
      deductions.refetch();
    },
  };
}

interface PayArgs {
  planId: string;
  amount: number;
}

/** Pay towards one merchandise plan from the agent's withdrawable wallet. */
export function usePayMerchandisePlan(userId?: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ planId, amount }: PayArgs) => {
      const { data, error } = await db.rpc('agent_pay_merchandise_plan', {
        p_plan_id: planId,
        p_amount: Math.floor(amount),
      });
      if (error) throw new Error(error.message);
      const result = (data || {}) as {
        success?: boolean;
        error?: string;
        amount_paid?: number;
        outstanding_after?: number;
        completed?: boolean;
        available?: number;
      };
      if (!result.success) {
        throw new Error(
          result.error === 'insufficient_funds'
            ? 'Your wallet does not have enough money for this payment yet.'
            : result.error === 'plan_not_active'
              ? 'This product is already fully paid.'
              : result.error === 'not_your_plan'
                ? 'This plan belongs to another person.'
                : 'Payment could not be completed. Please try again.',
        );
      }
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merchandise-repayment-plans', userId] });
      qc.invalidateQueries({ queryKey: ['merchandise-repayment-deductions', userId] });
      qc.invalidateQueries({ queryKey: ['my-merchandise-plans', userId] });
      qc.invalidateQueries({ queryKey: ['agent-commission-net', userId] });
      qc.invalidateQueries({ queryKey: ['wallet'] });
    },
  });
}
