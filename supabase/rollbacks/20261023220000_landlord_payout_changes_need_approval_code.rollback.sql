-- Takes the approval-code requirement off the landlord payout panel changes (Allow with exception keeps its own, from 20261023150000).
DROP TRIGGER IF EXISTS trg_guard_landlord_payouts_switch ON public.treasury_controls;
DROP FUNCTION IF EXISTS public.guard_landlord_payouts_switch();
DROP FUNCTION IF EXISTS public.set_landlord_payout_block_exemption(uuid[], boolean);
DROP FUNCTION IF EXISTS public.set_landlord_payout_budget(numeric, boolean);
ALTER FUNCTION public.set_landlord_payout_block_exemption_unchecked(uuid[], boolean) RENAME TO set_landlord_payout_block_exemption;
ALTER FUNCTION public.set_landlord_payout_budget_unchecked(numeric, boolean) RENAME TO set_landlord_payout_budget;
GRANT EXECUTE ON FUNCTION public.set_landlord_payout_block_exemption(uuid[], boolean), public.set_landlord_payout_budget(numeric, boolean) TO authenticated;
DROP FUNCTION IF EXISTS public.use_verified_scope_approval(text, uuid[], text);
DROP FUNCTION IF EXISTS public.request_landlord_payout_change_otp(text, uuid[], text, text);
DROP FUNCTION IF EXISTS public.exception_otp_scope(text, uuid[], text);
-- The table keeps its two new columns and the wider kind check; they are harmless.
