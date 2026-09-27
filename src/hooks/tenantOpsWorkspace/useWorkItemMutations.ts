/**
 * The only ways a client mutates tops_work_items — one hook per RPC
 * (tops_assign_work_item / tops_close_work_item / tops_escalate_work_item /
 * tops_snooze_work_item). No direct table write exists or is attempted here;
 * every mutation goes through its named, has_role-gated function.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

function useInvalidateWorkItems() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['tenantOpsWorkspace', 'myWorkItems'] });
    qc.invalidateQueries({ queryKey: ['tenantOpsWorkspace', 'workItemsByRentRequest'] });
    qc.invalidateQueries({ queryKey: ['tenantOpsWorkspace', 'workItemForRentRequest'] });
  };
}

export function useAssignWorkItem() {
  const invalidate = useInvalidateWorkItems();
  return useMutation({
    mutationFn: async (input: { workItemId: string; assignedTo: string }) => {
      const { error } = await anyDb.rpc('tops_assign_work_item', {
        p_work_item_id: input.workItemId,
        p_assigned_to: input.assignedTo,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useCloseWorkItem() {
  const invalidate = useInvalidateWorkItems();
  return useMutation({
    mutationFn: async (input: { workItemId: string; outcome: string }) => {
      const { error } = await anyDb.rpc('tops_close_work_item', {
        p_work_item_id: input.workItemId,
        p_outcome: input.outcome,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useEscalateWorkItem() {
  const invalidate = useInvalidateWorkItems();
  return useMutation({
    mutationFn: async (input: { workItemId: string; escalatedTo: string; note?: string }) => {
      const { error } = await anyDb.rpc('tops_escalate_work_item', {
        p_work_item_id: input.workItemId,
        p_escalated_to: input.escalatedTo,
        p_note: input.note || null,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useSnoozeWorkItem() {
  const invalidate = useInvalidateWorkItems();
  return useMutation({
    mutationFn: async (input: { workItemId: string; newSlaDueAt: string }) => {
      const { error } = await anyDb.rpc('tops_snooze_work_item', {
        p_work_item_id: input.workItemId,
        p_new_sla_due_at: input.newSlaDueAt,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}
