import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

export type ReturnsDeductionMode = 'amount' | 'percent';

export interface SmartphoneRepaymentMethods {
  active_plans: number;
  commission_enabled_plans: number;
  commission_enabled: boolean;
  returns_enabled: boolean;
  returns_mode: ReturnsDeductionMode | null;
  returns_value: number | null;
  returns_updated_at: string | null;
  active_portfolios: number;
  can_edit: boolean;
}

export interface SetSmartphoneRepaymentMethodsInput {
  useCommission: boolean;
  useReturns: boolean;
  returnsMode: ReturnsDeductionMode;
  returnsValue: number;
  reason?: string;
}

/** How an agent repays their Welile Smartphone: daily from commission (wallet), from partnership Returns, or both. */
export function useSmartphoneRepaymentMethods(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ['smartphone-repayment-methods', agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_smartphone_repayment_methods' as any, {
        p_agent_id: agentId,
      });
      if (error) throw error;
      return data as unknown as SmartphoneRepaymentMethods;
    },
  });
}

export function useSetSmartphoneRepaymentMethods(agentId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetSmartphoneRepaymentMethodsInput) => {
      if (!agentId) throw new Error('No agent selected');
      const { data, error } = await supabase.rpc('agent_ops_set_smartphone_repayment_methods' as any, {
        p_agent_id: agentId,
        p_use_commission: input.useCommission,
        p_use_returns: input.useReturns,
        p_returns_mode: input.useReturns ? input.returnsMode : null,
        p_returns_value: input.useReturns ? input.returnsValue : null,
        p_reason: input.reason?.trim() || null,
      });
      if (error) throw error;
      return data as unknown as SmartphoneRepaymentMethods;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['smartphone-repayment-methods', agentId], data);
      queryClient.invalidateQueries({ queryKey: ['agent-product-detail', agentId] });
      toast.success('Repayment method saved');
    },
    onError: (e: any) => toast.error(e?.message || 'Could not save the repayment method'),
  });
}

/** First repayment day per agent for active phone plans (CFO disbursement + 7-day grace). */
export function useSmartphoneRepaymentStartDates(enabled = true) {
  return useQuery({
    queryKey: ['smartphone-repayment-start-dates'],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_smartphone_repayment_start_dates' as any);
      if (error) throw error;
      const map = new Map<string, string>();
      for (const r of (data ?? []) as Array<{ agent_id: string; starts_on: string }>) map.set(r.agent_id, r.starts_on);
      return map;
    },
  });
}
