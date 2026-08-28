DO $$
DECLARE
  d1 text;
  d2 text;
  marker text;
BEGIN
  -- ---------- Overload 1: get_agent_products_services_report(p_date date) ----------
  SELECT pg_get_functiondef(p.oid) INTO d1
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_agent_products_services_report'
     AND pg_get_function_identity_arguments(p.oid) = 'p_date date';

  marker := '      count(*) FILTER (WHERE s.status IN (''verified'',''approved'')) AS active_total,';
  IF position(marker IN d1) = 0 THEN
    RAISE EXCEPTION 'overload 1 sc aggregate marker not found';
  END IF;

  d1 := replace(d1, marker,
    '      (SELECT count(*) FROM (SELECT DISTINCT lower(btrim(COALESCE(s.agent_phone, ''''))), lower(btrim(COALESCE(s.location_name, '''')))
         FROM service_centre_setups s
        WHERE s.status IN (''verified'',''approved'')
          AND btrim(COALESCE(s.agent_phone, '''')) <> ''''
          AND btrim(COALESCE(s.location_name, '''')) <> '''') d) AS active_total,');

  EXECUTE d1;

  -- ---------- Overload 2: get_agent_products_services_report(p_date date, p_from date) ----------
  SELECT pg_get_functiondef(p.oid) INTO d2
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_agent_products_services_report'
     AND pg_get_function_identity_arguments(p.oid) = 'p_date date, p_from date';

  marker := '    SELECT DISTINCT ON (agent_id, loc_key) id';
  IF position(marker IN d2) = 0 THEN
    RAISE EXCEPTION 'overload 2 sc_dedup marker not found';
  END IF;

  d2 := replace(d2, marker,
    '    SELECT DISTINCT ON (lower(btrim(COALESCE(agent_phone, ''''))), loc_key) id');
  d2 := replace(d2,
    '      AND agent_id IS NOT NULL' || E'\n' || '      AND loc_key <> ''''',
    '      AND btrim(COALESCE(agent_phone, '''')) <> ''''' || E'\n' || '      AND loc_key <> ''''');
  d2 := replace(d2,
    '    ORDER BY agent_id, loc_key, verified_at DESC NULLS LAST, created_at DESC',
    '    ORDER BY lower(btrim(COALESCE(agent_phone, ''''))), loc_key, verified_at DESC NULLS LAST, created_at DESC');

  EXECUTE d2;
END $$;