import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export type AgentPaymentStatus = 'paying' | 'not_paying';

interface Vars {
  rentRequestId: string;
  status: AgentPaymentStatus;
  reason: string;
}

/**
 * Agent-controlled per-rent payment status.
 * RPC: agent_set_rent_payment_status(uuid, text, text).
 * `not_paying` requires reason >= 10 chars (enforced server-side).
 */
export function useRentPaymentStatusMutation(agentId?: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ rentRequestId, status, reason }: Vars) => {
      const { data, error } = await supabase.rpc('agent_set_rent_payment_status', {
        p_rent_request_id: rentRequestId,
        p_status: status,
        p_reason: reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      toast.success(
        vars.status === 'not_paying'
          ? 'Tenant marked as Not Paying — excluded from your daily target.'
          : 'Tenant marked as Paying — re-included in your daily target.'
      );
      qc.invalidateQueries({ queryKey: ['priority-collection-queue', agentId] });
      qc.invalidateQueries({ queryKey: ['agent-daily-eligibility'] });
      qc.invalidateQueries({ queryKey: ['agent-capacity'] });
      qc.invalidateQueries({ queryKey: ['agent-tenants'] });
      qc.invalidateQueries({ queryKey: ['agent-dead-tenants'] });
    },
    onError: (err: any) => {
      const msg = err?.message || 'Could not update payment status.';
      toast.error(msg);
    },
  });
}
