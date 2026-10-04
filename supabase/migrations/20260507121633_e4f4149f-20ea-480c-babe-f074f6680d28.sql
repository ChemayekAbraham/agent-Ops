-- Remove the legacy hold trigger that writes to the now-virtual `wallets` view.
-- The `wallets` table was rewritten as a view over wallets_physical + v_user_wallet_strict,
-- so the UPDATE inside this trigger always errors with `cannot update view "wallets"`,
-- blocking every new withdrawal_requests insert.
--
-- The hold is no longer needed because:
--   1. enforce_withdrawal_ledger_match (BEFORE INSERT) already gates the
--      request against get_user_available_balance().
--   2. get_user_available_balance() already subtracts the sum of all pending /
--      requested / manager_approved / processing withdrawal_requests, so the
--      next user's balance check naturally accounts for in-flight requests
--      without any wallet write.
DROP TRIGGER IF EXISTS trg_deduct_wallet_on_withdrawal_request
  ON public.withdrawal_requests;

DROP FUNCTION IF EXISTS public.deduct_wallet_on_withdrawal_request();