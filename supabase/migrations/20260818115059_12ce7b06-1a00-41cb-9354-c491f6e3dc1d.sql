ALTER TABLE public.cash_deposit_verification_events
  DROP CONSTRAINT IF EXISTS cash_deposit_verification_events_event_type_check;
ALTER TABLE public.cash_deposit_verification_events
  ADD CONSTRAINT cash_deposit_verification_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'code_issued','code_reissued','attempt','code_mismatch','expired','locked_out',
    'verified','rejected','credited','credit_failed','already_verified','expiry_notice_emailed'
  ]));