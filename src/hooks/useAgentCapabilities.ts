/**
 * useAgentCapabilities — single source of truth for what the current agent
 * is allowed to do. Backed by the `agent_capabilities` table; layered with
 * helpers for parent/sub/cashout status (driven by underlying source tables).
 *
 * Returns `has(cap)` for capability gates and the convenience flags used by
 * surface gates (`isParentAgent`, `isSubAgent`, `canCashOut`).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export type Capability =
  | 'collect_rent'
  | 'onboard_tenants'
  | 'onboard_landlords'
  | 'capture_supporters'
  | 'act_as_proxy'
  | 'process_cash_out'
  | 'manage_subagents'
  | 'approve_subagents'
  | 'request_float'
  | 'view_agent_dashboard'
  | 'view_subagent_data';

interface CapabilitiesResult {
  capabilities: Set<Capability>;
  has: (cap: Capability) => boolean;
  isParentAgent: boolean;
  isSubAgent: boolean;
  canCashOut: boolean;
  isLoading: boolean;
}

const EMPTY: CapabilitiesResult = {
  capabilities: new Set(),
  has: () => false,
  isParentAgent: false,
  isSubAgent: false,
  canCashOut: false,
  isLoading: false,
};

export function useAgentCapabilities(): CapabilitiesResult {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['agent-capabilities', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      if (!user?.id) return null;
      const [capsRes, parentRes, subRes, cashoutRes] = await Promise.all([
        supabase
          .from('agent_capabilities')
          .select('capability')
          .eq('agent_id', user.id)
          .eq('status', 'active'),
        supabase.rpc('is_parent_agent', { _agent_id: user.id }),
        supabase.rpc('is_sub_agent', { _agent_id: user.id }),
        supabase.rpc('can_process_cashout', { _agent_id: user.id }),
      ]);
      const capabilities = new Set<Capability>(
        (capsRes.data || []).map((r: any) => r.capability as Capability),
      );
      return {
        capabilities,
        isParentAgent: !!parentRes.data,
        isSubAgent: !!subRes.data,
        canCashOut: !!cashoutRes.data,
      };
    },
  });

  if (!user || !data) return { ...EMPTY, isLoading };
  return {
    capabilities: data.capabilities,
    has: (cap: Capability) => data.capabilities.has(cap),
    isParentAgent: data.isParentAgent,
    isSubAgent: data.isSubAgent,
    canCashOut: data.canCashOut,
    isLoading,
  };
}