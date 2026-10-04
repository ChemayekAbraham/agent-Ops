DO $$
DECLARE
  r RECORD;
  v_def text;
  v_replaced boolean;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'get_agent_products_services_report'
  LOOP
    v_def := pg_get_functiondef(r.sig);
    v_replaced := false;

    IF position('WHERE status IN (''verified'', ''pending_acceptance'')' IN v_def) > 0 THEN
      v_def := replace(v_def,
        'WHERE status IN (''verified'', ''pending_acceptance'')',
        'WHERE status = ''verified''');
      v_replaced := true;
    END IF;

    IF position('FROM all_agents a
    LEFT JOIN profiles p ON p.id = a.uid' IN v_def) > 0 THEN
      v_def := replace(v_def,
        'FROM all_agents a
    LEFT JOIN profiles p ON p.id = a.uid',
        'FROM all_agents a
    JOIN profiles p ON p.id = a.uid AND p.verified IS TRUE');
      v_replaced := true;
    END IF;

    IF NOT v_replaced THEN
      RAISE EXCEPTION 'agents register filter anchors not found in %', r.sig;
    END IF;

    EXECUTE v_def;
  END LOOP;
END $$;