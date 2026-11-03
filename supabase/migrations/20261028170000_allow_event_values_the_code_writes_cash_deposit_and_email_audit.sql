-- Two more check constraints that refused values the live code writes (doc 247 step 48b/48c).
-- cash_deposit_verification_events.event_type: cash-deposit-verify-code logs confirmation_email_sent /
--   confirmation_email_failed / confirmation_receipt_failed after the wallet credit; none were allowed,
--   so those audit rows (and the "email sent" evidence) were never stored (4 refusals in the window).
-- email_match_audit_log.action: the Email Transactions panel writes tid_auto_credited (8 refusals).
-- Both lists are supersets of the old ones, so existing rows stay valid.
-- Applied to production by hand; this file is the record.
alter table public.cash_deposit_verification_events drop constraint if exists cash_deposit_verification_events_event_type_check;
alter table public.cash_deposit_verification_events add constraint cash_deposit_verification_events_event_type_check
  check (event_type = any (array[
    'code_issued', 'code_reissued', 'attempt', 'code_mismatch', 'expired', 'locked_out', 'verified',
    'rejected', 'credited', 'credit_failed', 'already_verified', 'expiry_notice_emailed',
    'confirmation_email_sent', 'confirmation_email_failed', 'confirmation_receipt_failed'
  ]::text[]));

alter table public.email_match_audit_log drop constraint if exists email_match_audit_log_action_check;
alter table public.email_match_audit_log add constraint email_match_audit_log_action_check
  check (action = any (array[
    'auto_claim', 'unclaim', 'manual_link', 'approve', 'bulk_approve', 'skip', 'auto_reject', 'tid_auto_credited'
  ]::text[]));
