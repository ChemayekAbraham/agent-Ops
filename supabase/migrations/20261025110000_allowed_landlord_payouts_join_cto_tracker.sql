-- Whenever the CTO allows a landlord payout into the Merchant Agent Payout Queue, its Rent Plan is added to the CTO-controlled tracker.
--
-- HOW: allowing a payout, by either route (Allow selected, or Allow with exception), sets withdrawal_requests.landlord_block_exempt_at. A trigger on
-- that column watches for it going from empty to set and adds the payout's Rent Plan (landlord_payouts.rent_request_id) to cto_controlled_rent_plans.
-- It catches both routes, and anything else that sets the marker, so no screen has to remember to do it.
--
-- ONLY WHEN THE CTO ALLOWED IT: the person who allowed it (landlord_block_exempt_by, or the signed-in user when the exception route did not record
-- one) must hold the CTO role. A payout allowed by the CFO or a super admin is not added; it is not a CTO decision. Plans already on the list are left alone.
-- The list row records who allowed it, with the note "Allowed to the payout queue by the CTO", and an audit row is written.
-- The trigger can never stop a payout being allowed: any problem inside it is logged as a warning and ignored.
--
-- FORWARD ONLY. Plans the CTO allowed before this file are NOT added (335 payouts allowed since 25 Sep; 294 of those plans are not on the list).
-- To add them as well, run the backfill statement at the bottom of this file deliberately; it is commented out.
-- Needs 20261024130000_cto_controlled_rent_plans.sql. Roll back with 20261025110000_allowed_landlord_payouts_join_cto_tracker.rollback.sql.

CREATE OR REPLACE FUNCTION public.add_allowed_payout_plan_to_cto_tracker()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_by uuid; v_plan uuid; v_rows integer;
BEGIN
  BEGIN
    IF NEW.landlord_payout_id IS NULL THEN RETURN NEW; END IF;
    v_by := COALESCE(NEW.landlord_block_exempt_by, auth.uid());
    IF v_by IS NULL OR NOT public.has_role(v_by, 'cto'::app_role) THEN RETURN NEW; END IF;

    SELECT lp.rent_request_id INTO v_plan FROM public.landlord_payouts lp WHERE lp.id = NEW.landlord_payout_id;
    IF v_plan IS NULL THEN RETURN NEW; END IF;

    INSERT INTO public.cto_controlled_rent_plans (rent_request_id, added_by, note)
    VALUES (v_plan, v_by, 'Allowed to the payout queue by the CTO')
    ON CONFLICT (rent_request_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows > 0 THEN
      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      VALUES (v_by, 'cto_controlled_plans_added', 'Added a Rent Plan to the CTO-controlled list because its landlord payout was allowed', 'cto_controlled_rent_plans', v_plan::text,
              jsonb_build_object('source', 'allowed_to_payout_queue', 'withdrawal_id', NEW.id, 'rent_request_id', v_plan));
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'add_allowed_payout_plan_to_cto_tracker: % (the payout is still allowed)', SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.add_allowed_payout_plan_to_cto_tracker() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_allowed_payout_to_cto_tracker ON public.withdrawal_requests;
CREATE TRIGGER trg_allowed_payout_to_cto_tracker
  AFTER UPDATE OF landlord_block_exempt_at ON public.withdrawal_requests
  FOR EACH ROW
  WHEN (OLD.landlord_block_exempt_at IS NULL AND NEW.landlord_block_exempt_at IS NOT NULL)
  EXECUTE FUNCTION public.add_allowed_payout_plan_to_cto_tracker();

-- OPTIONAL BACKFILL (not run): put every Rent Plan whose payout the CTO has ALREADY allowed on the tracker. This adds about 294 plans and changes
-- the tracker's totals. Uncomment and run it only if that is what you want.
-- INSERT INTO public.cto_controlled_rent_plans (rent_request_id, added_by, added_at, note)
-- SELECT DISTINCT ON (lp.rent_request_id) lp.rent_request_id, w.landlord_block_exempt_by, w.landlord_block_exempt_at, 'Backfill: allowed to the payout queue by the CTO'
--   FROM public.withdrawal_requests w JOIN public.landlord_payouts lp ON lp.id = w.landlord_payout_id
--  WHERE w.landlord_block_exempt_at IS NOT NULL AND lp.rent_request_id IS NOT NULL
--    AND public.has_role(w.landlord_block_exempt_by, 'cto'::app_role)
--  ORDER BY lp.rent_request_id, w.landlord_block_exempt_at
-- ON CONFLICT (rent_request_id) DO NOTHING;
