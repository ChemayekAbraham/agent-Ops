import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { agentVettingKey } from '@/hooks/useAgentVetting';
import {
  classifyMissing, fetchGateStatus, fetchV2Missing, saveHomeLc1,
  type GateStatus, type MissingItem,
} from '@/lib/agentVettingV2';

export const agentVettingV2MissingKey = (agentId: string | undefined) => ['agent-vetting-v2-missing', agentId] as const;
export const agentVettingGateKey = (agentId: string | undefined) => ['agent-vetting-gate-status', agentId] as const;

/**
 * Verification v2 for the signed-in agent: what is still missing (server list), the
 * gate status with its expiry, and saving the home LC1 letter. Runs only once the
 * caller knows this is an agent's verification screen (`enabled`).
 */
export function useAgentVettingV2(enabled: boolean) {
  const { user } = useAuth();
  const agentId = user?.id;
  const qc = useQueryClient();
  const on = enabled && !!agentId;

  const missing = useQuery({
    queryKey: agentVettingV2MissingKey(agentId),
    enabled: on,
    staleTime: 30_000,
    queryFn: () => fetchV2Missing(agentId as string),
  });
  const gate = useQuery({
    queryKey: agentVettingGateKey(agentId),
    enabled: on,
    staleTime: 60_000,
    queryFn: () => fetchGateStatus(agentId as string),
  });

  const saveLc1 = useMutation({
    mutationFn: (file: File) => {
      if (!agentId) throw new Error('Please sign in again.');
      return saveHomeLc1(agentId, file);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentVettingV2MissingKey(agentId) });
      void qc.invalidateQueries({ queryKey: agentVettingGateKey(agentId) });
      void qc.invalidateQueries({ queryKey: agentVettingKey(agentId) });
    },
  });

  const items: MissingItem[] | null = missing.data ? missing.data.map(classifyMissing) : null;
  return {
    /** null until the server list has loaded (or when it could not be loaded). */
    missing: items,
    missingFailed: missing.isError,
    gate: (gate.data ?? null) as GateStatus | null,
    saveHomeLc1: saveLc1.mutateAsync,
    savingHomeLc1: saveLc1.isPending,
    homeLc1Saved: saveLc1.isSuccess,
  };
}
