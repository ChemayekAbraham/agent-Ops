/**
 * Reveal flow, replicated exactly as src/hooks/useCcCallingHub.ts does it:
 * this is not an RPC — it looks for an existing unrecorded attempt on this
 * roster row for the current officer, opens a new cc_call_attempts row only
 * if none exists, then calls the existing cc_reveal_phone RPC. No cc_ object
 * is altered; this is the same direct-insert pattern the current calling UI
 * already uses.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export function useCallReveal() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (cycleRowId: string) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error('Not signed in');

      const { data: existing } = await supabase
        .from('cc_call_attempts')
        .select('id')
        .eq('cycle_row_id', cycleRowId)
        .eq('caller_id', userId)
        .is('recorded_at', null)
        .order('revealed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let attemptId = (existing as { id?: string } | null)?.id ?? null;

      if (!attemptId) {
        const { data: attempt, error } = await supabase
          .from('cc_call_attempts')
          .insert({
            cycle_row_id: cycleRowId,
            caller_id: userId,
            revealed_at: new Date().toISOString(),
            source: 'self_reported',
          } as never)
          .select('id')
          .single();
        if (error) throw error;
        attemptId = (attempt as { id: string }).id;
      }

      const { data: phone, error: phoneError } = await anyDb.rpc('cc_reveal_phone', { p_attempt_id: attemptId });
      if (phoneError) throw phoneError;

      return { attemptId, phone: (phone as string) ?? null };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenantOpsWorkspace', 'callingQueue'] });
      qc.invalidateQueries({ queryKey: ['tenantOpsWorkspace', 'callingStateCounts'] });
    },
  });
}
