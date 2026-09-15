/**
 * Edit trail for one call's feedback.
 *
 * Read-only over `cc_feedback_amendments`, the append-only log written by the
 * `cc_amend_feedback` RPC. Nothing here writes; the original feedback record and
 * every prior version stay intact and visible.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CcSeverity } from '@/hooks/useCcCallingHub';

export interface CcFeedbackAmendment {
  id: string;
  feedbackId: string;
  attemptId: string;
  editedAt: string;
  editedBy: string | null;
  editorName: string | null;
  reason: string;
  oldCategoryLabel: string | null;
  newCategoryLabel: string | null;
  oldSeverity: CcSeverity | null;
  newSeverity: CcSeverity | null;
  oldNote: string | null;
  newNote: string | null;
}

export function useCcFeedbackAmendments(attemptIds: string[], enabled = true) {
  const key = [...attemptIds].sort().join(',');
  return useQuery({
    queryKey: ['cc-feedback-amendments', key],
    enabled: enabled && attemptIds.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<CcFeedbackAmendment[]> => {
      const client = supabase as any;
      const { data, error } = await client
        .from('cc_feedback_amendments')
        .select(
          'id, feedback_id, attempt_id, edited_at, edited_by, reason, old_category_id, new_category_id, old_severity, new_severity, old_note, new_note',
        )
        .in('attempt_id', attemptIds)
        .order('edited_at', { ascending: false });
      if (error) throw error;
      const rows = (data || []) as any[];
      if (!rows.length) return [];

      const catIds = [
        ...new Set(rows.flatMap((r) => [r.old_category_id, r.new_category_id]).filter(Boolean)),
      ] as string[];
      const catMap = new Map<string, string>();
      if (catIds.length) {
        const { data: cats } = await client.from('cc_feedback_categories').select('id, label').in('id', catIds);
        ((cats || []) as { id: string; label: string | null }[]).forEach((c) => {
          if (c.label) catMap.set(c.id, c.label);
        });
      }

      const editorIds = [...new Set(rows.map((r) => r.edited_by).filter(Boolean))] as string[];
      const editorMap = new Map<string, string>();
      if (editorIds.length) {
        const { data: people } = await client.from('profiles').select('id, full_name').in('id', editorIds);
        ((people || []) as { id: string; full_name: string | null }[]).forEach((p) => {
          if (p.full_name) editorMap.set(p.id, p.full_name);
        });
      }

      return rows.map((r) => ({
        id: r.id,
        feedbackId: r.feedback_id,
        attemptId: r.attempt_id,
        editedAt: r.edited_at,
        editedBy: r.edited_by ?? null,
        editorName: r.edited_by ? editorMap.get(r.edited_by) ?? null : null,
        reason: r.reason ?? '',
        oldCategoryLabel: r.old_category_id ? catMap.get(r.old_category_id) ?? null : null,
        newCategoryLabel: r.new_category_id ? catMap.get(r.new_category_id) ?? null : null,
        oldSeverity: r.old_severity ?? null,
        newSeverity: r.new_severity ?? null,
        oldNote: r.old_note ?? null,
        newNote: r.new_note ?? null,
      }));
    },
  });
}

/**
 * Tracked edit of an existing feedback record. All validation, the before/after
 * log and the audit entry live in the `cc_amend_feedback` RPC — the client only
 * passes the new values through.
 */
export function useAmendCcFeedback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      feedbackId: string;
      categoryId: string;
      severity: CcSeverity;
      note: string;
      reason: string;
    }) => {
      const { data, error } = await (supabase as any).rpc('cc_amend_feedback', {
        p_feedback_id: input.feedbackId,
        p_category_id: input.categoryId,
        p_severity: input.severity,
        p_note: input.note,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cc-feedback-amendments'] });
      queryClient.invalidateQueries({ queryKey: ['cc-subject-call-history'] });
      queryClient.invalidateQueries({ queryKey: ['cc-call-history'] });
    },
  });
}
