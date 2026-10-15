import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface ReviewNote {
  id: string;
  request_id: string;
  author: string;
  author_name: string | null;
  author_role: string;
  stage: string;
  note: string;
  created_at: string;
}

/** The roles that may add a review note. The database enforces this too (add_rent_request_review_note). */
export const REVIEW_NOTE_ROLES = ['agent_ops', 'tenant_ops', 'landlord_ops', 'coo', 'cfo', 'super_admin'] as const;

export const REVIEW_NOTE_MIN = 10;

export const REVIEW_ROLE_LABEL: Record<string, string> = {
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  coo: 'COO',
  cfo: 'CFO',
  super_admin: 'Admin',
};

/** Append-only notes on a rent request, oldest first, read through the table's own access rules. */
export function useRentRequestReviewNotes(requestId: string | null, enabled = true) {
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!requestId) return;
    setLoading(true); setError(null);
    try {
      const { data, error: err } = await supabase
        .from('rent_request_review_notes')
        .select('id, request_id, author, author_role, stage, note, created_at')
        .eq('request_id', requestId)
        .order('created_at', { ascending: true });
      if (err) throw err;
      const rows = data ?? [];
      const ids = [...new Set(rows.map((r) => r.author))];
      const names = new Map<string, string | null>();
      if (ids.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', ids);
        (profiles ?? []).forEach((p) => names.set(p.id, p.full_name));
      }
      setNotes(rows.map((r) => ({ ...r, author_name: names.get(r.author) ?? null })));
    } catch {
      setError('Notes could not be loaded. Try again.');
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => { if (enabled) void load(); }, [enabled, load]);

  /** Adds a note through the RPC (the only write path); refreshes the thread. Throws the database's message on failure. */
  const addNote = useCallback(async (note: string) => {
    if (!requestId) return;
    const { error: err } = await supabase.rpc('add_rent_request_review_note', { p_request_id: requestId, p_note: note.trim() });
    if (err) throw err;
    await load();
  }, [requestId, load]);

  return { notes, loading, error, reload: load, addNote };
}
