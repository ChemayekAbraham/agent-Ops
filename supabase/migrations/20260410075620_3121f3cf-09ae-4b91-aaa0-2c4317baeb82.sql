-- Drop the rogue trigger that directly mutates wallets.balance outside the ledger.
-- The trigger function deduct_wallet_on_withdrawal_request() remains (harmless without the trigger).
-- Balance checks now happen at approval time via the approve-withdrawal edge function.
DROP TRIGGER IF EXISTS trg_deduct_wallet_on_withdrawal_request ON public.withdrawal_requests;