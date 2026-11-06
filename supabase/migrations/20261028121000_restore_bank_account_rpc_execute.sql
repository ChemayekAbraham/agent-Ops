-- Gives signed-in users back the right to call the bank account RPCs the web and the Android app depend on.
--
-- WHAT BROKE: saving a withdrawal bank account and asking for a bank account change failed with
-- "permission denied for function request_bank_account_change". EXECUTE on these three functions is held by service_role only, not by
-- authenticated (checked 28 Oct). They were caught by the owner-rights lockdown (20261017140000), which revoked functions it judged unused; these are
-- called from the apps by name (Android: BankLockRepository.requestChange / save, web: the withdrawal bank form).
--   * request_bank_account_change(text, text, text, text)  an agent asks Financial Ops to change a locked bank account.
--   * save_withdrawal_bank_account(text, text, text)       first save of the bank account a user withdraws to.
--   * finops_decide_bank_account_change(uuid, text, text)  Financial Ops approves or rejects that request.
-- WHY IT IS SAFE: each function checks the caller itself. request_ and save_ return "Sign in first" when auth.uid() is null and only ever act on the
-- caller's own account. finops_decide_ raises unless the caller holds financial_ops, cfo, super_admin or manager. anon and PUBLIC stay without access.
-- Roll back with 20261028121000_restore_bank_account_rpc_execute.rollback.sql.

GRANT EXECUTE ON FUNCTION public.request_bank_account_change(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_withdrawal_bank_account(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finops_decide_bank_account_change(uuid, text, text) TO authenticated;
