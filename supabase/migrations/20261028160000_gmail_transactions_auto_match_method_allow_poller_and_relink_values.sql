-- gmail_transactions.auto_match_method: 12 check violations a day (doc 247 step 48a).
-- gmail-poll-transactions writes 'merchant_float_sms_rpc' after crediting a merchant float SMS, and
-- relink_stuck_pending_deposits writes 'relink_job'; neither value was in the live constraint, so the
-- row was never marked matched (the money was still credited, the poller ignores the update error).
-- Applied to production by hand; this file is the record.
alter table public.gmail_transactions drop constraint if exists gmail_transactions_auto_match_method_check;
alter table public.gmail_transactions add constraint gmail_transactions_auto_match_method_check
  check (auto_match_method = any (array[
    'tid', 'amount', 'amount_strong', 'already_approved_tid', 'already_credited_cfo',
    'late_email_tid_match', 'gmail_phone+tid+amount', 'trigger_linked_instant_approve',
    'merchant_float_sms_rpc', 'relink_job'
  ]::text[])) not valid;
alter table public.gmail_transactions validate constraint gmail_transactions_auto_match_method_check;
