-- Takes the bank account RPCs back from signed-in users (as the lockdown had them).

REVOKE EXECUTE ON FUNCTION public.request_bank_account_change(text, text, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.save_withdrawal_bank_account(text, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.finops_decide_bank_account_change(uuid, text, text) FROM authenticated;
