-- Orphaned idempotency reservation from the reversal of 2026-08-23 whose credit leg
-- never executed. cfo-direct-credit deletes this row by reference_id on its
-- ledger-failure rollback; that rollback did not run because the flow terminated
-- between the debit and credit legs. This restores the state the code intended.
delete from public.email_credit_idempotency
where reference_id = 'PAY-MT64YONB-HQ1I'
  and email_tid = 'TID154538650276'
  and target_user_id = 'd2e87bf9-936a-4b9d-98b0-5d25e8db4cc3'
  and operation = 'debit';