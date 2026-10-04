DO $$
DECLARE
  v_rr public.rent_requests;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_pins integer := 0;
  v_applied jsonb;
BEGIN
  SELECT * INTO v_rr FROM public.rent_requests
   WHERE id = '743d30e7-5cf6-425c-a3bd-aad12ecfbe2d' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan not found'; END IF;

  UPDATE public.rent_requests
     SET repayment_frequency = 'daily',
         repayment_frequency_locked = true,
         repayment_starts_on = COALESCE(repayment_starts_on, '2026-09-04'::date),
         updated_at = now()
   WHERE id = v_rr.id;

  DELETE FROM public.agent_expected_day_plans
   WHERE rent_request_id = v_rr.id AND day >= v_today;
  GET DIAGNOSTICS v_pins = ROW_COUNT;

  BEGIN
    v_applied := public.rent_apply_collections_to_days(v_rr.id);
  EXCEPTION WHEN OTHERS THEN
    v_applied := jsonb_build_object('status','skipped','error',SQLERRM);
  END;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    NULL,
    'ops.set_rent_plan_frequency',
    'rent_requests',
    v_rr.id::text,
    jsonb_build_object(
      'reason','Correction: tenant pays daily, plan was mis-flagged weekly and distorted the agent daily target',
      'old_frequency','weekly',
      'new_frequency','daily',
      'repayment_starts_on', COALESCE(v_rr.repayment_starts_on, '2026-09-04'::date),
      'tenant_id', v_rr.tenant_id,
      'agent_id', COALESCE(v_rr.assigned_agent_id, v_rr.agent_id),
      'daily_repayment', COALESCE(v_rr.daily_repayment,0),
      'pins_cleared', v_pins,
      'reallocation', v_applied,
      'changed_by','system_correction'
    )
  );
END $$;