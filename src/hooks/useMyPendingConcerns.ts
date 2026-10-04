/**
 * Concerns forwarded to the signed-in person that they have not yet seen.
 *
 * Reads through `cc_my_pending_concerns()` and records "seen" through
 * `cc_acknowledge_concern()`. Both are SECURITY DEFINER and only ever touch the
 * caller's own reviewer row — no concern status, permission or audit-trail
 * behaviour is changed here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface PendingConcern {
  concern_id: string;
  title: string;
  context: string | null;
  priority: string;
  status: string;
  due_at: string | null;
  caller_name: string | null;
  subject_type: string | null;
  forwarded_by_name: string | null;
  added_by_name: string | null;
  added_reason: string | null;
  reviewer_role: string | null;
  notified_at: string | null;
  assigned_at: string | null;
  participant_count: number;
}

const anyDb = supabase as any;

export const MY_PENDING_CONCERNS_KEY = ['cc-my-pending-concerns'];

export function useMyPendingConcerns(enabled = true) {
  return useQuery({
    queryKey: MY_PENDING_CONCERNS_KEY,
    enabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<PendingConcern[]> => {
      const { data, error } = await anyDb.rpc('cc_my_pending_concerns');
      if (error) throw new Error(error.message);
      return (data ?? []) as PendingConcern[];
    },
  });
}

/** Marks one concern, or every outstanding one, as seen by the signed-in person. */
export function useAcknowledgeConcerns() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (concernId?: string | null) => {
      const { data, error } = await anyDb.rpc('cc_acknowledge_concern', {
        p_concern_id: concernId ?? null,
      });
      if (error) throw new Error(error.message);
      return Number(data ?? 0);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MY_PENDING_CONCERNS_KEY });
      void qc.invalidateQueries({ queryKey: ['cc-concern-reviewers'] });
    },
  });
}
