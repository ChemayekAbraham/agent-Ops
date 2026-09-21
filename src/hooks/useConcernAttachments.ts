/**
 * Files carried by a forwarded concern, and the authoritative person/call behind it.
 *
 * Both sit beside the existing concern spine and change none of its rules. Reads
 * are governed by the same row-level reach as the concern itself
 * (`cc_can_view_concern`), so a file is visible to exactly the people who can see
 * the concern — the officer who forwarded it, everyone it was forwarded to or
 * added to at any stage, and the named overseers.
 *
 * Files live in the private `concern-attachments` bucket under `<concern_id>/…`,
 * so they belong to the concern and survive forwarding, reassignment, hand-offs
 * and completion. Nothing is ever deleted.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const CONCERN_BUCKET = 'concern-attachments';
export const CONCERN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const anyDb = supabase as any;

export interface ConcernAttachment {
  id: string;
  concern_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  kind: 'image' | 'document' | string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
}

export interface ConcernCaseContext {
  concern_id: string;
  source_kind: 'outbound_call' | 'received_call';
  subject_type: string | null;
  caller_name: string | null;
  person_id: string | null;
  person: {
    user_id?: string;
    full_name?: string | null;
    phone?: string | null;
    email?: string | null;
    district?: string | null;
    national_id?: string | null;
    created_at?: string | null;
    roles?: string[] | null;
    agent_name?: string | null;
    agent_phone?: string | null;
    active_plan?: {
      id: string;
      status: string | null;
      rent_amount: number | null;
      total_repayment: number | null;
      amount_repaid: number | null;
      daily_repayment: number | null;
      created_at: string | null;
    } | null;
  };
  call: {
    kind: 'received_call' | 'outbound_call';
    called_at?: string | null;
    recorded_by_name?: string | null;
    caller_name_recorded?: string | null;
    caller_phone_recorded?: string | null;
    linked_kind?: string | null;
    is_registered?: boolean;
    concern?: string | null;
    notes?: string | null;
    call_status?: string | null;
    follow_up_at?: string | null;
    follow_up_note?: string | null;
    attempt_outcome?: string | null;
    channel?: string | null;
    row_state?: string | null;
    attempt_no?: number | null;
    feedback_note?: string | null;
    feedback_severity?: string | null;
    feedback_category?: string | null;
  };
}

export function useConcernAttachments(concernId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['cc-concern-attachments', concernId],
    enabled: !!concernId && enabled,
    queryFn: async (): Promise<ConcernAttachment[]> => {
      const { data, error } = await anyDb
        .from('cc_concern_attachments')
        .select('*')
        .eq('concern_id', concernId)
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as ConcernAttachment[];
    },
  });
}

export function useConcernCaseContext(concernId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['cc-concern-context', concernId],
    enabled: !!concernId && enabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<ConcernCaseContext | null> => {
      const { data, error } = await anyDb.rpc('cc_concern_context', { p_concern_id: concernId });
      if (error) throw new Error(error.message);
      return (data ?? null) as ConcernCaseContext | null;
    },
  });
}

const safeName = (name: string) =>
  name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(-120) || 'file';

/** Upload one or more files and record each against the concern. */
export async function uploadConcernAttachments(concernId: string, files: File[]) {
  for (const file of files) {
    if (file.size > CONCERN_ATTACHMENT_MAX_BYTES) {
      throw new Error(`${file.name} is larger than 10MB.`);
    }
    const path = `${concernId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName(file.name)}`;
    const { error: upErr } = await supabase.storage
      .from(CONCERN_BUCKET)
      .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (upErr) throw new Error(upErr.message);

    const { error: rpcErr } = await anyDb.rpc('cc_add_concern_attachment', {
      p_concern_id: concernId,
      p_storage_path: path,
      p_file_name: file.name,
      p_mime_type: file.type || null,
      p_size_bytes: file.size,
    });
    if (rpcErr) {
      await supabase.storage.from(CONCERN_BUCKET).remove([path]);
      throw new Error(rpcErr.message);
    }
  }
}

export function useUploadConcernAttachments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { concern_id: string; files: File[] }) => {
      await uploadConcernAttachments(input.concern_id, input.files);
      return true;
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['cc-concern-attachments', vars.concern_id] });
    },
  });
}

/** Short-lived link for viewing or downloading one stored file. */
export async function concernAttachmentUrl(path: string) {
  const { data, error } = await supabase.storage.from(CONCERN_BUCKET).createSignedUrl(path, 300);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
