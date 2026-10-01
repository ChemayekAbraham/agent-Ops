DO $m$
DECLARE v_oid oid; v_def text; v_old text; v_new text;
BEGIN
  SELECT p.oid INTO STRICT v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='crm_callee_dossier';
  v_def := pg_get_functiondef(v_oid);
  v_old := $o$WHERE ac.tenant_id=p_user_id AND ac.reversed_at IS NULL ORDER BY ac.created_at DESC LIMIT 1)$o$;
  v_new := v_old || $n$,
      'paid_totals', (SELECT jsonb_build_object(
          'today', jsonb_build_object('amount', coalesce(sum(amount) FILTER (WHERE d = (now() AT TIME ZONE 'Africa/Kampala')::date),0), 'count', count(*) FILTER (WHERE d = (now() AT TIME ZONE 'Africa/Kampala')::date)),
          'yesterday', jsonb_build_object('amount', coalesce(sum(amount) FILTER (WHERE d = (now() AT TIME ZONE 'Africa/Kampala')::date - 1),0), 'count', count(*) FILTER (WHERE d = (now() AT TIME ZONE 'Africa/Kampala')::date - 1)),
          'month', jsonb_build_object('amount', coalesce(sum(amount) FILTER (WHERE d >= date_trunc('month', now() AT TIME ZONE 'Africa/Kampala')::date),0), 'count', count(*) FILTER (WHERE d >= date_trunc('month', now() AT TIME ZONE 'Africa/Kampala')::date)),
          'all', jsonb_build_object('amount', coalesce(sum(amount),0), 'count', count(*)))
        FROM (SELECT ac.amount, (ac.created_at AT TIME ZONE 'Africa/Kampala')::date d FROM agent_collections ac
               WHERE ac.tenant_id=p_user_id AND ac.reversed_at IS NULL) x)$n$;
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'crm_callee_dossier last_collection block not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $m$;