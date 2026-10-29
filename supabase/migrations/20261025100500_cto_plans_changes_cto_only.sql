-- Only the CTO can change the list of CTO-controlled Rent Plans. Not even a super admin.
--
-- 20261024130000 let "the CTO or a super admin" add and remove plans. This replaces cto_add_controlled_plans and cto_remove_controlled_plans with
-- the same bodies and a stricter check: the caller must hold the CTO role. A super admin who is not also CTO is refused (42501). Reading the
-- tracker is unchanged (CTO, CEO and CFO). Changes from the SQL editor or a migration (no signed-in user) are not affected.
-- Roll back with 20261025100500_cto_plans_changes_cto_only.rollback.sql.

CREATE OR REPLACE FUNCTION public.cto_add_controlled_plans(p_rent_request_ids uuid[], p_note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_added uuid[];
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'cto'::app_role) THEN
    RAISE EXCEPTION 'Only the CTO can change the CTO-controlled Rent Plans' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR cardinality(p_rent_request_ids) = 0 THEN RETURN 0; END IF;
  WITH ins AS (
    INSERT INTO public.cto_controlled_rent_plans (rent_request_id, added_by, note)
    SELECT r.id, v_uid, NULLIF(btrim(COALESCE(p_note, '')), '') FROM public.rent_requests r WHERE r.id = ANY (p_rent_request_ids)
    ON CONFLICT (rent_request_id) DO NOTHING
    RETURNING rent_request_id)
  SELECT array_agg(rent_request_id) INTO v_added FROM ins;
  IF v_added IS NOT NULL THEN
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    VALUES (v_uid, 'cto_controlled_plans_added', 'Added Rent Plans to the CTO-controlled list', 'cto_controlled_rent_plans', NULL,
            jsonb_build_object('rent_request_ids', v_added, 'count', cardinality(v_added), 'note', p_note));
  END IF;
  RETURN COALESCE(cardinality(v_added), 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.cto_remove_controlled_plans(p_rent_request_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_removed uuid[];
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'cto'::app_role) THEN
    RAISE EXCEPTION 'Only the CTO can change the CTO-controlled Rent Plans' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR cardinality(p_rent_request_ids) = 0 THEN RETURN 0; END IF;
  WITH del AS (DELETE FROM public.cto_controlled_rent_plans WHERE rent_request_id = ANY (p_rent_request_ids) RETURNING rent_request_id)
  SELECT array_agg(rent_request_id) INTO v_removed FROM del;
  IF v_removed IS NOT NULL THEN
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    VALUES (v_uid, 'cto_controlled_plans_removed', 'Removed Rent Plans from the CTO-controlled list', 'cto_controlled_rent_plans', NULL,
            jsonb_build_object('rent_request_ids', v_removed, 'count', cardinality(v_removed)));
  END IF;
  RETURN COALESCE(cardinality(v_removed), 0);
END;
$function$;
