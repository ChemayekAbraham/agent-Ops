-- Every Rent Plan goes on the CTO-controlled tracker, so every collection on every plan can be tracked there.
--
-- 1. BACKFILL: all Rent Plans that have been funded (status funded, repaying or completed; 1,832 on 26 Oct 2026, of which 54 were already on the list)
--    are added, with the note "All Rent Plans". Plans already on the list keep their note. Cancelled plans are not added (40 were funded first;
--    add those by hand from "Manage CTO plans" if wanted).
-- 2. FROM NOW ON: a plan joins the list the first time it becomes funded (a new Rent Plan, or a renewal). A plan the CTO later removes from the list stays
--    off it: the trigger only fires on that first move into funded, repaying or completed, never on later status changes.
--    The trigger can never stop a plan being funded: any problem inside it is a warning only.
--
-- Adding plans to the list changes no money. It is only the filter the tracker reads. Needs 20261024130000.
-- Things to know when reading the totals for older plans:
--   * "Recovered" is the plan's amount_repaid counter; the collections figure is what agents posted (agent_collections). For older plans these differ,
--     because tenants also repaid by other routes (the tracker flags those plans as counter mismatches: 585 of 1,832 on 26 Oct).
--   * The Partner / agent / platform split only exists for collections that carry ledger rows.
-- Roll back with 20261025130000_cto_tracker_all_rent_plans.rollback.sql.

INSERT INTO public.cto_controlled_rent_plans (rent_request_id, added_by, note)
SELECT r.id, NULL, 'All Rent Plans'
  FROM public.rent_requests r
 WHERE r.status IN ('funded', 'repaying', 'completed')
ON CONFLICT (rent_request_id) DO NOTHING;

INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
SELECT NULL, 'cto_controlled_plans_added', 'Added every funded Rent Plan to the CTO-controlled list', 'cto_controlled_rent_plans', NULL,
       jsonb_build_object('source', 'all_rent_plans_backfill', 'count', (SELECT count(*) FROM public.cto_controlled_rent_plans WHERE note = 'All Rent Plans'));

CREATE OR REPLACE FUNCTION public.add_funded_plan_to_cto_tracker()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    INSERT INTO public.cto_controlled_rent_plans (rent_request_id, added_by, note)
    VALUES (NEW.id, NULL, 'All Rent Plans')
    ON CONFLICT (rent_request_id) DO NOTHING;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'add_funded_plan_to_cto_tracker: % (the plan is still funded)', SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.add_funded_plan_to_cto_tracker() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_funded_plan_to_cto_tracker_ins ON public.rent_requests;
CREATE TRIGGER trg_funded_plan_to_cto_tracker_ins
  AFTER INSERT ON public.rent_requests
  FOR EACH ROW
  WHEN (NEW.status IN ('funded', 'repaying', 'completed'))
  EXECUTE FUNCTION public.add_funded_plan_to_cto_tracker();

DROP TRIGGER IF EXISTS trg_funded_plan_to_cto_tracker_upd ON public.rent_requests;
CREATE TRIGGER trg_funded_plan_to_cto_tracker_upd
  AFTER UPDATE OF status ON public.rent_requests
  FOR EACH ROW
  WHEN (NEW.status IN ('funded', 'repaying', 'completed') AND COALESCE(OLD.status, '') NOT IN ('funded', 'repaying', 'completed'))
  EXECUTE FUNCTION public.add_funded_plan_to_cto_tracker();
