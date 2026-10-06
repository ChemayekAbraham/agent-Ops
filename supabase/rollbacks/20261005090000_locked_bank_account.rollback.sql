-- Rollback for 20261005090000_locked_bank_account.sql
-- Removes the rule, the functions and the tables. Dropping the tables discards every locked bank account and every
-- change request, so users can use any bank account again.

DROP TRIGGER IF EXISTS trg_enforce_withdrawal_bank_account_lock ON public.withdrawal_requests;
DROP FUNCTION IF EXISTS public.enforce_withdrawal_bank_account_lock();
DROP FUNCTION IF EXISTS public.finops_decide_bank_account_change(uuid, text, text);
DROP FUNCTION IF EXISTS public.finops_bank_account_change_requests(text);
DROP FUNCTION IF EXISTS public.cancel_bank_account_change(uuid);
DROP FUNCTION IF EXISTS public.request_bank_account_change(text, text, text, text);
DROP FUNCTION IF EXISTS public.save_withdrawal_bank_account(text, text, text);
DROP FUNCTION IF EXISTS public.my_bank_account_lock();
DROP TABLE IF EXISTS public.bank_account_change_requests;
DROP TABLE IF EXISTS public.locked_bank_accounts;
