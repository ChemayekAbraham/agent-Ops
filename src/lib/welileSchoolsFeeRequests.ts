/**
 * School Fees Plan requests: an agent asks Welile to pay a registered student's term fees.
 * The request is saved through the SECURITY DEFINER RPC welile_school_fee_request_submit
 * (migration 20261112150000); ops approve it later. No money moves at this step.
 */
import { supabase } from '@/integrations/supabase/client';

// Not in the generated Supabase types until Lovable regenerates them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type FeeRequestStatus = 'submitted' | 'approved' | 'rejected' | 'cancelled';

export interface FeeRequestRow {
  id: string;
  school_id: string;
  profile_id: string;
  student_name: string;
  class_grade: string | null;
  term_end: string;
  plan_due_date: string;
  term_fee: number;
  plan_days: number;
  daily_rate: number;
  total_on_schedule: number;
  guardian_name: string;
  guardian_phone: string;
  guarantor_name: string | null;
  guarantor_phone: string | null;
  status: FeeRequestStatus;
  review_note: string | null;
  created_at: string;
}

export const FEE_REQUEST_STATUS_LABEL: Record<FeeRequestStatus, string> = {
  submitted: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Not approved',
  cancelled: 'Cancelled',
};

export interface FeeRequestInput {
  profileId: string;
  termId: string | null;
  termEnd: string | null;
  termFee: number;
  guardianName: string;
  guardianPhone: string;
  guarantorName?: string;
  guarantorPhone?: string;
  note?: string;
}

/** Plain-language message for an RPC error. */
export function feeRequestErrorMessage(error: unknown): string {
  const msg = String((error as { message?: string })?.message ?? error ?? '');
  if (msg.includes('REQUEST_ALREADY_OPEN')) return 'This student already has an open School Fees Plan request.';
  if (msg.includes('TERM_TOO_SHORT')) return 'Too close to the end of term. Plans are cleared 14 days before the term ends and need at least 14 days to run.';
  if (msg.includes('NOT_A_SCHOOL_AGENT')) return 'Only Welile Schools agents can request school fees.';
  if (msg.includes('STUDENT_NOT_FOUND') || msg.includes('NOT_A_STUDENT')) return 'Choose a registered student.';
  if (msg.includes('INVALID_TERM_FEE')) return 'Enter the term fee.';
  if (msg.includes('GUARDIAN_NAME_REQUIRED')) return "Enter the parent or guardian's name.";
  if (msg.includes('TERM_END_REQUIRED') || msg.includes('TERM_NOT_FOUND')) return 'Choose the term or its end date.';
  if (/function .* does not exist|PGRST202|schema cache/i.test(msg)) return 'School fees requests are not switched on yet. Nothing was saved.';
  return msg || 'Could not send the request.';
}

export async function submitFeeRequest(input: FeeRequestInput): Promise<FeeRequestRow> {
  const { data, error } = await db.rpc('welile_school_fee_request_submit', {
    p_profile_id: input.profileId,
    p_term_id: input.termId,
    p_term_end: input.termId ? null : input.termEnd,
    p_term_fee: input.termFee,
    p_guardian_name: input.guardianName,
    p_guardian_phone: input.guardianPhone,
    p_guarantor_name: input.guarantorName || null,
    p_guarantor_phone: input.guarantorPhone || null,
    p_note: input.note || null,
  });
  if (error) throw error;
  return data as FeeRequestRow;
}

/** This agent's requests at one school, newest first. Empty when the table is not there yet. */
export async function fetchFeeRequests(schoolId: string): Promise<FeeRequestRow[]> {
  const { data, error } = await db.from('welile_school_fee_requests').select('*')
    .eq('school_id', schoolId).order('created_at', { ascending: false }).limit(200);
  if (error) return [];
  return (data ?? []) as FeeRequestRow[];
}

export type FeeRequestDecision = 'approve' | 'reject';

/** Ops: approve or reject a submitted request (welile_school_fee_request_review). */
export async function reviewFeeRequest(requestId: string, decision: FeeRequestDecision, note: string): Promise<FeeRequestRow> {
  const { data, error } = await db.rpc('welile_school_fee_request_review', {
    p_request_id: requestId, p_decision: decision, p_note: note || null,
  });
  if (error) throw error;
  return data as FeeRequestRow;
}

/** Plain-language message for a review error. */
export function feeReviewErrorMessage(error: unknown): string {
  const msg = String((error as { message?: string })?.message ?? error ?? '');
  if (msg.includes('SCHOOL_NOT_APPROVED')) return "Approve the school's partnership (payout account, terms and fees) first.";
  if (msg.includes('REASON_REQUIRED')) return 'Give the agent a reason (at least 5 characters).';
  if (msg.includes('REQUEST_NOT_PENDING')) return 'This request has already been decided.';
  if (msg.includes('NOT_AUTHORIZED')) return 'Only Welile Schools ops can decide fee requests.';
  if (/function .* does not exist|PGRST202|schema cache/i.test(msg)) return 'Fee request review is not switched on yet. Nothing was saved.';
  return msg || 'Could not save the decision.';
}
