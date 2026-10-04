ALTER TABLE public.email_payout_match_attempts
  DROP CONSTRAINT IF EXISTS email_payout_match_attempts_outcome_chk;

ALTER TABLE public.email_payout_match_attempts
  ADD CONSTRAINT email_payout_match_attempts_outcome_chk CHECK (outcome = ANY (ARRAY[
    'matched_auto_approved',
    'matched_approve_failed',
    'matched_manual_retry_ok',
    'matched_manual_retry_failed',
    'tid_burned_skip',
    'no_match',
    'skipped_reconciled_tid',
    'skipped_emergency_stop',
    'merchant_float_credited',
    'merchant_float_credit_failed',
    'float_phone_no_match',
    'skipped_double_debit',
    'skipped_merchant_agent',
    'no_recipient_match',
    'insufficient_balance',
    'no_payout_intent',
    'debit_failed',
    'debited',
    'debited_partial'
  ]));