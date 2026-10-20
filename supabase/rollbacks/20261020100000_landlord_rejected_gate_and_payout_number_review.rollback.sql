-- Rollback for 20261020100000_landlord_rejected_gate_and_payout_number_review.sql
-- Only new objects were added. Approved numbers already confirmed through confirm_landlord_payout_number() keep their new value and are
-- findable with verified_mobile_money_source = 'payout_number_reconcile' (and landlord_number_audit event 'payout_number_reconciled').
DROP TRIGGER IF EXISTS trg_block_review_rejected_landlord ON public.rent_requests;
DROP FUNCTION IF EXISTS public.block_rent_plan_review_for_rejected_landlord();
DROP FUNCTION IF EXISTS public.confirm_landlord_payout_number(uuid, text, text);
DROP FUNCTION IF EXISTS public.get_landlord_payout_number_review(text, integer, integer);
DROP FUNCTION IF EXISTS public.can_review_landlord_payout_numbers(uuid);
