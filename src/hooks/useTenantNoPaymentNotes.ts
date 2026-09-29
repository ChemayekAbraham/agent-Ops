import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

/**
 * Notes/Activity log for the "20+ Days No Payment" tab (Classic Tenant Ops ->
 * Weekly Performance). `tenant_no_payment_notes` rows are never updated or
 * deleted — each note is a new row. `v_tenant_no_payment_notes_summary` gives
 * the per-tenant "most recent note" rollup used by the tab's list view.
 *
 * Mirrors src/hooks/useTenantCallReports.ts's shape/conventions (the sibling
 * append-only call-log feature elsewhere in Classic Tenant Ops).
 */

const anyDb = supabase as any;

export interface TenantNoPaymentNoteSummary {
  tenant_id: string;
  notes_count: number;
  last_note: string | null;
  last_note_type: string | null;
  last_created_by: string | null;
  last_note_at: string | null;
}

export interface TenantNoPaymentNote {
  id: string;
  tenant_id: string;
  note: string;
  note_type: string;
  follow_up_date: string | null;
  follow_up_status: string | null;
  related_action: string | null;
  created_by: string;
  created_at: string;
  /** Resolved from `profiles.full_name` for display — not a DB column. */
  created_by_name: string;
}

/** Per-tenant "most recent note" rollup, for the list view's preview badge. */
export function useTenantNoPaymentNotesSummaries() {
  return useQuery({
    queryKey: ['tenant-no-payment-notes-summaries'],
    queryFn: async () => {
      const all: TenantNoPaymentNoteSummary[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await anyDb
          .from('v_tenant_no_payment_notes_summary')
          .select('*')
          .range(from, from + page - 1);
        if (error) throw error;
        all.push(...((data || []) as TenantNoPaymentNoteSummary[]));
        if (!data || data.length < page) break;
      }
      const map = new Map<string, TenantNoPaymentNoteSummary>();
      all.forEach((r) => map.set(r.tenant_id, r));
      return map;
    },
    staleTime: 30000,
  });
}

/** Full, untruncated note history for one tenant (newest first), with author names resolved. */
export function useTenantNoPaymentNoteHistory(tenantId?: string | null) {
  const query = useQuery({
    queryKey: ['tenant-no-payment-note-history', tenantId],
    queryFn: async () => {
      const { data, error } = await anyDb
        .from('tenant_no_payment_notes')
        .select('id, tenant_id, note, note_type, follow_up_date, follow_up_status, related_action, created_by, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as Omit<TenantNoPaymentNote, 'created_by_name'>[];
    },
    enabled: !!tenantId,
    staleTime: 15000,
  });

  const authorIds = useMemo(
    () => [...new Set((query.data || []).map((n) => n.created_by))],
    [query.data],
  );

  const { data: authors } = useQuery({
    queryKey: ['tenant-no-payment-note-authors', authorIds.join(',')],
    queryFn: async () => {
      const map = new Map<string, string>();
      if (!authorIds.length) return map;
      const { data } = await anyDb.from('profiles').select('id, full_name').in('id', authorIds);
      (data || []).forEach((p: any) => map.set(p.id, p.full_name || 'Unknown'));
      return map;
    },
    enabled: authorIds.length > 0,
    staleTime: 300000,
  });

  const notes: TenantNoPaymentNote[] = (query.data || []).map((n) => ({
    ...n,
    created_by_name: authors?.get(n.created_by) || n.created_by,
  }));

  return { ...query, data: notes };
}

export function useAddTenantNoPaymentNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { tenantId: string; note: string }) => {
      const trimmed = input.note.trim();
      if (!trimmed) throw new Error('Note cannot be empty.');
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error('You must be signed in to add a note.');
      const { error } = await anyDb.from('tenant_no_payment_notes').insert({
        tenant_id: input.tenantId,
        note: trimmed,
        created_by: uid,
      });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['tenant-no-payment-notes-summaries'] });
      qc.invalidateQueries({ queryKey: ['tenant-no-payment-note-history', vars.tenantId] });
      toast.success('Note added');
    },
    onError: (e: any) => toast.error(e?.message || 'Could not add the note'),
  });
}
