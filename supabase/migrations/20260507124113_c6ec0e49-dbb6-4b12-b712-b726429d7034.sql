-- Drop obsolete handle_withdrawal_approval trigger that tried to UPDATE the wallets view directly.
-- The new ledger-first flow holds funds via a withdrawal_pending ledger leg at request time
-- and the reject-withdrawal / approve-withdrawal edge functions post all wallet movements
-- through create_ledger_transaction (the only sanctioned path). This trigger now only
-- causes "cannot update view wallets" failures on every status transition.

DROP TRIGGER IF EXISTS on_withdrawal_approved ON public.withdrawal_requests;
DROP FUNCTION IF EXISTS public.handle_withdrawal_approval();