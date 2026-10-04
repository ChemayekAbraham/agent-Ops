import { useEffect } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const db = supabase as any;

export interface BikeLeasePlan {
  id: string;
  sale_id: string | null;
  item_name: string | null;
  original_amount: number;
  outstanding_balance: number;
  amount_recovered: number;
  daily_deduction_amount: number | null;
  starts_on: string | null;
  status: string;
  last_recovery_at: string | null;
}

export interface BikeLeaseDeduction {
  id: string;
  plan_id: string;
  amount: number;
  outstanding_after: number;
  created_at: string;
}

/**
 * Live repayment tracker for one agent bike lease: the recovery plan behind the
 * sale plus every deduction already taken off it. Read-only — money movement
 * only ever happens through the SECURITY DEFINER recovery/payment functions.
 */
export function useBikeLeaseRepayment(userId?: string, saleId?: string) {
  const qc = useQueryClient();

  const plan = useQuery<BikeLeasePlan | null>({
    queryKey: ['bike-lease-plan', userId, saleId],
    enabled: !!userId && !!saleId,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_recovery_plans')
        .select(
          'id, sale_id, item_name, original_amount, outstanding_balance, amount_recovered, daily_deduction_amount, starts_on, status, last_recovery_at',
        )
        .eq('customer_id', userId)
        .eq('sale_id', saleId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      return ((data || [])[0] ?? null) as BikeLeasePlan | null;
    },
  });

  const planId = plan.data?.id;

  const deductions = useQuery<BikeLeaseDeduction[]>({
    queryKey: ['bike-lease-deductions', planId],
    enabled: !!planId,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_recovery_deductions')
        .select('id, plan_id, amount, outstanding_after, created_at')
        .eq('plan_id', planId)
        .order('created_at', { ascending: false })
        .limit(120);
      if (error) throw error;
      return (data || []) as BikeLeaseDeduction[];
    },
  });

  /** Polled every 60s (+ on focus) so a newly recorded deduction shows up.
   *  Was a Realtime listener on merchandise_recovery_deductions/_plans, which
   *  are not in the publication, so it never fired (doc 147). */
  usePolling(
    () => Promise.all([
      qc.invalidateQueries({ queryKey: ['bike-lease-plan', userId, saleId] }),
      qc.invalidateQueries({ queryKey: ['bike-lease-deductions', planId] }),
    ]),
    60_000,
    { enabled: !!userId },
  );

  const paid = Number(plan.data?.amount_recovered || 0);
  const original = Number(plan.data?.original_amount || 0);
  const remaining = Math.max(0, Number(plan.data?.outstanding_balance || 0));

  return {
    plan: plan.data ?? null,
    deductions: deductions.data ?? [],
    paid,
    original,
    remaining,
    progressPct: original > 0 ? Math.min(100, Math.round((paid / original) * 100)) : 0,
    cleared: !!plan.data && remaining <= 0,
    isLoading: plan.isLoading,
  };
}
