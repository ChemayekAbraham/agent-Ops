import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * "I approve" — tenant payment readiness for a rent request.
 *
 * Landlord ops, agent ops, tenant ops and service centre managers record that
 * the tenant was trained (by Jen / Grace) to pay by themselves via mobile money
 * and confirmed they understand their rent top-up access limit. When
 * treasury_controls.enforce_tenant_readiness_gate is on, the DB refuses to move
 * a rent request into coo_approved / approved / funded / disbursed / repaying
 * without an unrevoked record. See docs/HANDOVER/121.
 *
 * New objects are not in the generated types yet, hence the `as any` casts.
 */

export type TenantReadinessRecord = {
  id: string;
  rent_request_id: string;
  tenant_id: string;
  access_limit_at_attestation: number | null;
  trained_by_name: string;
  note: string | null;
  attested_by: string;
  attested_role: 'tenant_ops' | 'landlord_ops' | 'agent_ops' | 'service_center_manager';
  created_at: string;
};

export type TenantReadinessApproverRole = TenantReadinessRecord['attested_role'];

const db = supabase as any;
const readinessKey = (rentRequestId: string | null | undefined) => ['tenant-payment-readiness', rentRequestId];

/** Current (unrevoked) readiness approval for one rent request, or null. */
export function useTenantPaymentReadiness(rentRequestId: string | null | undefined) {
  return useQuery({
    queryKey: readinessKey(rentRequestId),
    enabled: !!rentRequestId,
    queryFn: async (): Promise<TenantReadinessRecord | null> => {
      const { data, error } = await db
        .from('rent_request_tenant_readiness')
        .select('id, rent_request_id, tenant_id, access_limit_at_attestation, trained_by_name, note, attested_by, attested_role, created_at')
        .eq('rent_request_id', rentRequestId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as TenantReadinessRecord | null) ?? null;
    },
  });
}

/** Readiness for many rent requests at once (pipeline lists): Map<rentRequestId, record>. */
export function useTenantPaymentReadinessMap(rentRequestIds: string[]) {
  const ids = [...new Set(rentRequestIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ['tenant-payment-readiness-map', ids],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Map<string, TenantReadinessRecord>> => {
      const map = new Map<string, TenantReadinessRecord>();
      // Chunk to keep the `in` filter URL short.
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await db
          .from('rent_request_tenant_readiness')
          .select('id, rent_request_id, tenant_id, access_limit_at_attestation, trained_by_name, note, attested_by, attested_role, created_at')
          .in('rent_request_id', ids.slice(i, i + 150))
          .is('revoked_at', null)
          .order('created_at', { ascending: false });
        if (error) throw error;
        for (const row of (data ?? []) as TenantReadinessRecord[]) {
          if (!map.has(row.rent_request_id)) map.set(row.rent_request_id, row);
        }
      }
      return map;
    },
  });
}

/** Which approver role the signed-in user holds, or null if they cannot press "I approve". */
export function useTenantReadinessApproverRole() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['tenant-readiness-approver-role', user?.id],
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<TenantReadinessApproverRole | null> => {
      const { data, error } = await db.rpc('tenant_readiness_approver_role', { p_user: user!.id });
      if (error) throw error;
      return (data as TenantReadinessApproverRole | null) ?? null;
    },
  });
}

/** Whether the approval gate is switched on (treasury_controls). */
export function useTenantReadinessGateEnabled() {
  return useQuery({
    queryKey: ['tenant-readiness-gate-enabled'],
    staleTime: 60_000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await db
        .from('treasury_controls')
        .select('enabled')
        .eq('control_key', 'enforce_tenant_readiness_gate')
        .maybeSingle();
      if (error) throw error;
      return !!data?.enabled;
    },
  });
}

export type RecordTenantReadinessInput = {
  rentRequestId: string;
  momoSelfPayTrained: boolean;
  accessLimitUnderstood: boolean;
  trainedByName: string;
  note?: string;
};

function invalidateReadiness(qc: ReturnType<typeof useQueryClient>, rentRequestId?: string) {
  qc.invalidateQueries({ queryKey: readinessKey(rentRequestId) });
  qc.invalidateQueries({ queryKey: ['tenant-payment-readiness-map'] });
}

/** The "I approve" action. Both confirmations must be true; the RPC re-checks role and routing. */
export function useRecordTenantPaymentReadiness() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordTenantReadinessInput) => {
      const { data, error } = await db.rpc('record_tenant_payment_readiness', {
        p_rent_request_id: input.rentRequestId,
        p_momo_self_pay_trained: input.momoSelfPayTrained,
        p_access_limit_understood: input.accessLimitUnderstood,
        p_trained_by_name: input.trainedByName.trim(),
        p_note: input.note?.trim() || null,
      });
      if (error) throw error;
      return data as { readiness_id: string; rent_request_id: string; attested_role: TenantReadinessApproverRole; access_limit: number | null };
    },
    onSuccess: (_data, input) => invalidateReadiness(qc, input.rentRequestId),
  });
}

/** Undo a mistaken approval; the gate blocks final approval again. */
export function useRevokeTenantPaymentReadiness() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readinessId: string; rentRequestId: string; reason: string }) => {
      const { error } = await db.rpc('revoke_tenant_payment_readiness', {
        p_readiness_id: input.readinessId,
        p_reason: input.reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: (_data, input) => invalidateReadiness(qc, input.rentRequestId),
  });
}

/** True when a DB error is the readiness gate refusing an approval. */
export const isTenantNotReadyError = (e: unknown) =>
  typeof (e as { message?: string })?.message === 'string' && (e as { message: string }).message.includes('TENANT_NOT_READY');
