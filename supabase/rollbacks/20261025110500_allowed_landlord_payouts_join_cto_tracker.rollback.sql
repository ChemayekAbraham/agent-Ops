-- Stops adding plans to the CTO-controlled tracker when a landlord payout is allowed. Plans already added stay on the list (remove them with
-- cto_remove_controlled_plans if wanted).
DROP TRIGGER IF EXISTS trg_allowed_payout_to_cto_tracker ON public.withdrawal_requests;
DROP FUNCTION IF EXISTS public.add_allowed_payout_plan_to_cto_tracker();
