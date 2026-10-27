-- auto_create_deposits_from_gmail_impl marks a receipt already_credited_cfo
-- when the MoMo TID is already on email_routing_history or a ledger
-- sub_category. The check from 20261026181837 never listed that label, so
-- the first successful TID match aborted the sweep and rolled the batch back.
-- Existing labels stay. NULL stays allowed.

ALTER TABLE public.gmail_transactions DROP CONSTRAINT gmail_transactions_auto_match_method_check;
ALTER TABLE public.gmail_transactions ADD CONSTRAINT gmail_transactions_auto_match_method_check
  CHECK (auto_match_method = ANY (ARRAY[
    'tid'::text, 'amount'::text, 'amount_strong'::text,
    'already_approved_tid'::text, 'already_credited_cfo'::text,
    'late_email_tid_match'::text,
    'gmail_phone+tid+amount'::text, 'trigger_linked_instant_approve'::text
  ]));
