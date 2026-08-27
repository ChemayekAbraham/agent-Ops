import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { MerchantCapacityOverrideInput } from '@/lib/merchantFloatCapacity';

/**
 * Temporary admin overrides on a merchant desk's qualified daily capacity.
 *
 * Recommendation layer only — an override changes the figure Financial Ops sees
 * and how an entered distribution pot is split. It moves no money, touches no
 * wallet bucket and posts no ledger entry. Every set/revoke is written to
 * `audit_logs` by the database function, with a mandatory reason.
 */
export interface MerchantCapacityOverride {
  id: string;
  agentId: string;
  agentName: string;
  overrideCapacity: number;
  effectiveFrom: string;
  expiresAt: string;
  reason: string;
  status: 'active' | 'revoked' | 'expired';
  isInForce: boolean;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  revokedBy: string | null;
  revokedByName: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

const mapRow = (r: any): MerchantCapacityOverride => ({
  id: r.id,
  agentId: r.agent_id,
  agentName: r.agent_name ?? 'Merchant agent',
  overrideCapacity: Number(r.override_capacity ?? 0),
  effectiveFrom: r.effective_from,
  expiresAt: r.expires_at,
  reason: r.reason ?? '',
  status: (r.status ?? 'active') as MerchantCapacityOverride['status'],
  isInForce: !!r.is_in_force,
  createdBy: r.created_by,
  createdByName: r.created_by_name ?? 'Financial Ops',
  createdAt: r.created_at,
  revokedBy: r.revoked_by ?? null,
  revokedByName: r.revoked_by_name ?? null,
  revokedAt: r.revoked_at ?? null,
  revokeReason: r.revoke_reason ?? null,
});

export function useMerchantCapacityOverrides(limit = 200) {
  return useQuery({
    queryKey: ['merchant-capacity-overrides', limit],
    queryFn: async (): Promise<MerchantCapacityOverride[]> => {
      const { data, error } = await supabase.rpc('merchant_capacity_overrides_report' as any, {
        p_limit: limit,
      });
      if (error) throw error;
      return ((data as any[]) ?? []).map(mapRow);
    },
    staleTime: 60_000,
  });
}

/** Only the overrides actually in force right now, keyed by agent. */
export function activeOverrideMap(
  rows: MerchantCapacityOverride[] | undefined,
): Map<string, MerchantCapacityOverrideInput> {
  const map = new Map<string, MerchantCapacityOverrideInput>();
  (rows ?? [])
    .filter((r) => r.isInForce)
    .forEach((r) => {
      if (!map.has(r.agentId)) {
        map.set(r.agentId, {
          id: r.id,
          capacity: r.overrideCapacity,
          reason: r.reason,
          expiresAt: r.expiresAt,
          setBy: r.createdByName,
        });
      }
    });
  return map;
}

export function useSetMerchantCapacityOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      agentId: string;
      capacity: number;
      days: number;
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc('set_merchant_capacity_override' as any, {
        p_agent_id: vars.agentId,
        p_capacity: vars.capacity,
        p_days: vars.days,
        p_reason: vars.reason,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merchant-capacity-overrides'] });
    },
  });
}

export function useRevokeMerchantCapacityOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { overrideId: string; reason: string }) => {
      const { error } = await supabase.rpc('revoke_merchant_capacity_override' as any, {
        p_override_id: vars.overrideId,
        p_reason: vars.reason,
      });
      if (error) throw error;
      return true;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merchant-capacity-overrides'] });
    },
  });
}

/**
 * Apply capacity overrides to several merchant desks in one action.
 *
 * One shared reason, one duration per desk. Each desk is written through the same
 * guarded `set_merchant_capacity_override` function that the single-desk screen
 * uses, so the authority check, the reason requirement and the audit trail are
 * identical. Writes are issued concurrently in small batches (no N+1 waterfall)
 * and a per-desk outcome is returned so a partial failure is visible instead of
 * silent. Recommendation layer only — no wallet, float or ledger movement.
 */
export function useBulkSetMerchantCapacityOverrides() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      items: { agentId: string; agentName: string; capacity: number; days: number }[];
      reason: string;
    }) => {
      if (vars.reason.trim().length < 10) {
        throw new Error('A reason of at least 10 characters is required');
      }
      const bad = vars.items.find(
        (i) => !(i.capacity >= 0) || !(i.days >= 1 && i.days <= 90),
      );
      if (bad) throw new Error(`Invalid amount or duration for ${bad.agentName}`);

      const results: { agentId: string; agentName: string; ok: boolean; message?: string }[] = [];
      const CHUNK = 5;
      for (let i = 0; i < vars.items.length; i += CHUNK) {
        const slice = vars.items.slice(i, i + CHUNK);
        const settled = await Promise.all(
          slice.map(async (item) => {
            const { error } = await supabase.rpc('set_merchant_capacity_override' as any, {
              p_agent_id: item.agentId,
              p_capacity: item.capacity,
              p_days: item.days,
              p_reason: vars.reason.trim(),
            });
            return {
              agentId: item.agentId,
              agentName: item.agentName,
              ok: !error,
              message: error?.message,
            };
          }),
        );
        results.push(...settled);
      }
      return results;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merchant-capacity-overrides'] });
    },
  });
}
