-- Stops new funded plans joining the tracker and takes off every plan the "all Rent Plans" backfill or trigger added (note 'All Rent Plans').
-- Plans added by hand, by the first backfill (54 plans from 19-24 Oct) or by allowing a landlord payout keep their own notes and stay.
DROP TRIGGER IF EXISTS trg_funded_plan_to_cto_tracker_ins ON public.rent_requests;
DROP TRIGGER IF EXISTS trg_funded_plan_to_cto_tracker_upd ON public.rent_requests;
DROP FUNCTION IF EXISTS public.add_funded_plan_to_cto_tracker();
DELETE FROM public.cto_controlled_rent_plans WHERE note = 'All Rent Plans';
