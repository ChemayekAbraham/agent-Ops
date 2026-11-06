-- "cannot execute INSERT in a read-only transaction" from get_partner_wallet_hub (doc 247 step 48d).
-- These four functions were declared STABLE but call get_user_wallet_view(), which is VOLATILE and
-- rebuilds the user's wallet_balances_projection row when it is missing or out of date. PostgREST
-- runs a STABLE function in a read-only transaction, so the rebuild failed and the screen got an
-- error instead of the wallet. VOLATILE is what they really are; results and grants are unchanged.
-- Applied to production by hand; this file is the record.
alter function public.get_partner_wallet_hub(uuid, integer, integer) volatile;
alter function public.get_withdraw_context volatile;
alter function public.get_phantom_correction_drift volatile;
alter function public.get_phantom_correction_drift_detail volatile;
