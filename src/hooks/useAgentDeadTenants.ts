import { useQuery } from '@tanstack/react-query';
import { differenceInDays } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import type { AgentPaymentStatus } from '@/hooks/useRentPaymentStatusMutation';

export interface DeadTenant {
  rent_request_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string;
  outstanding: number;
  daily_repayment: number;
  amount_repaid: number;
  days_overdue: number;
  agent_payment_status: AgentPaymentStatus;
}

/**
 * "Dead" / inactive tenants for an agent: still marked as paying, funded,
 * owing money, and significantly overdue (>= 7 days behind on the daily plan).
 * These drag down the agent's 7-day breadth performance grade until cleaned up
 * (deactivated via "Not Paying").
 */
const DEAD_OVERDUE_DAYS = 7;

export function useAgentDeadTenants(agentId?: string) {
  return useQuery({
    queryKey: ['agent-dead-tenants', agentId],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async (): Promise<DeadTenant[]> => {
      const { data: requests, error } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, daily_repayment, amount_repaid, total_repayment, disbursed_at, status, agent_payment_status')
        .eq('agent_id', agentId as string)
        .in('status', ['funded', 'repaying']);
      if (error) throw error;
      if (!requests?.length) return [];

      const tenantIds = [...new Set(requests.map((r) => r.tenant_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', tenantIds);
      const profileMap: Record<string, { name: string; phone: string }> = {};
      (profiles || []).forEach((p) => {
        profileMap[p.id] = { name: p.full_name, phone: p.phone || '' };
      });

      const dead: DeadTenant[] = [];
      for (const r of requests) {
        const status = ((r as any).agent_payment_status ?? 'paying') as AgentPaymentStatus;
        if (status === 'not_paying') continue; // already deactivated
        const outstanding = Math.max(0, (r.total_repayment || 0) - (r.amount_repaid || 0));
        if (outstanding <= 0) continue; // paid up
        const daysOverdue = r.disbursed_at
          ? Math.max(
              0,
              differenceInDays(new Date(), new Date(r.disbursed_at)) -
                Math.floor((r.amount_repaid || 0) / (r.daily_repayment || 1)),
            )
          : 0;
        if (daysOverdue < DEAD_OVERDUE_DAYS) continue;
        dead.push({
          rent_request_id: r.id,
          tenant_id: r.tenant_id,
          tenant_name: profileMap[r.tenant_id]?.name || 'Unknown tenant',
          tenant_phone: profileMap[r.tenant_id]?.phone || '',
          outstanding,
          daily_repayment: r.daily_repayment || 0,
          amount_repaid: r.amount_repaid || 0,
          days_overdue: daysOverdue,
          agent_payment_status: status,
        });
      }

      return dead.sort((a, b) => b.outstanding - a.outstanding);
    },
  });
}

export default useAgentDeadTenants;