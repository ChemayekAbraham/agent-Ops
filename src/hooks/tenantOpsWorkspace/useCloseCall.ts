/**
 * Closing a call REQUIRES an outcome. This always does two things:
 *  1. Closes the underlying cc_call_attempts row via the SAME existing RPC
 *     the current calling UI uses (cc_record_unreached / cc_record_engaged),
 *     so the engine's own state machine (retries, WIP, etc.) is never left
 *     dangling by our new screen — we read the engine and add beside it, but
 *     an attempt we opened must still be closed the way the engine expects.
 *  2. Records our own, richer outcome in tops_call_outcomes.
 * An optional promise is inserted into tops_promises_to_pay when the officer
 * captures one (typically alongside outcome = 'promised').
 *
 * The two existing cc_feedback_categories used below ("No issue raised",
 * "Payment or statement dispute") already exist for exactly this purpose —
 * confirmed live, not invented for this task.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export type TopsCallOutcome =
  | 'reached'
  | 'promised'
  | 'refused'
  | 'unreachable'
  | 'wrong_number'
  | 'disputes_balance'
  | 'other';

const NO_ISSUE_CATEGORY_ID = 'a5bbe5a7-94e3-4a9c-909c-d384c9bd95c7'; // "No issue raised"
const PAYMENT_DISPUTE_CATEGORY_ID = '2850c003-8ae1-4b37-ac21-3098b49e8082'; // "Payment or statement dispute"

export interface ClosCallInput {
  attemptId: string;
  rentRequestId: string;
  tenantUserId: string;
  outcome: TopsCallOutcome;
  note: string;
  promise?: {
    promisedAmountUgx: number;
    promisedDate: string;
    channel: 'call' | 'sms' | 'visit' | 'whatsapp';
  };
}

export function useCloseCall() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: ClosCallInput) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error('Not signed in');

      switch (input.outcome) {
        case 'refused': {
          const { error } = await anyDb.rpc('cc_record_unreached', { p_attempt_id: input.attemptId, p_outcome: 'refused' });
          if (error) throw error;
          break;
        }
        case 'unreachable': {
          const { error } = await anyDb.rpc('cc_record_unreached', { p_attempt_id: input.attemptId, p_outcome: 'no_answer' });
          if (error) throw error;
          break;
        }
        case 'wrong_number': {
          const { error } = await anyDb.rpc('cc_record_unreached', { p_attempt_id: input.attemptId, p_outcome: 'wrong_number' });
          if (error) throw error;
          break;
        }
        case 'disputes_balance': {
          const { error } = await anyDb.rpc('cc_record_engaged', {
            p_attempt_id: input.attemptId,
            p_category_id: PAYMENT_DISPUTE_CATEGORY_ID,
            p_severity: 'normal',
            p_note: input.note,
            p_routed_to_staff_id: null,
            p_consent: true,
          });
          if (error) throw error;
          break;
        }
        case 'reached':
        case 'promised':
        case 'other':
        default: {
          const { error } = await anyDb.rpc('cc_record_engaged', {
            p_attempt_id: input.attemptId,
            p_category_id: NO_ISSUE_CATEGORY_ID,
            p_severity: 'normal',
            p_note: input.note,
            p_routed_to_staff_id: null,
            p_consent: true,
          });
          if (error) throw error;
          break;
        }
      }

      const { error: outcomeError } = await supabase.from('tops_call_outcomes').insert({
        cc_call_id: input.attemptId,
        rent_request_id: input.rentRequestId,
        outcome: input.outcome,
        note: input.note || null,
        recorded_by: userId,
      } as never);
      if (outcomeError) throw outcomeError;

      if (input.promise) {
        const { error: promiseError } = await supabase.from('tops_promises_to_pay').insert({
          rent_request_id: input.rentRequestId,
          tenant_user_id: input.tenantUserId,
          cc_call_id: input.attemptId,
          promised_amount_ugx: input.promise.promisedAmountUgx,
          promised_date: input.promise.promisedDate,
          channel: input.promise.channel,
          taken_by: userId,
        } as never);
        if (promiseError) throw promiseError;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenantOpsWorkspace', 'callingQueue'] });
      qc.invalidateQueries({ queryKey: ['tenantOpsWorkspace', 'callingStateCounts'] });
      qc.invalidateQueries({ queryKey: ['cc-subject-call-history'] });
    },
  });
}
