import { supabase } from '@/integrations/supabase/client';

export interface PromissoryApprovalPreview {
  note_id: string;
  partner_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  payout_amount: number;
  pso_bonus_excluded: boolean;
  attached_plans: number;
  attached_amount: number;
  blocked_reason: string | null;
  eligible: boolean;
}

export async function fetchPromissoryApprovalPreview(ids: string[]): Promise<PromissoryApprovalPreview[]> {
  const { data, error } = await supabase.rpc('preview_promissory_note_approvals', { p_note_ids: ids });
  if (error) throw error;
  const result = data as unknown as { notes: PromissoryApprovalPreview[] };
  if (!Array.isArray(result?.notes)) throw new Error('Could not load payout preview');
  return result.notes;
}

export function approvalPreviewFingerprint(rows: PromissoryApprovalPreview[]): string {
  return JSON.stringify([...rows].sort((a, b) => a.note_id.localeCompare(b.note_id)));
}