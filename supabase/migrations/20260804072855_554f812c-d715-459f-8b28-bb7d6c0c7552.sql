DO $$
DECLARE
  r record;
  v_def text;
BEGIN
  FOR r IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_agent_advance_potential', 'get_agent_advance_potential_for')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_def := replace(v_def, '* 3000000', '* 900000');
    v_def := replace(v_def, 'GREATEST(30000,', 'GREATEST(20000,');
    v_def := replace(v_def, 'LEAST(
        GREATEST(COALESCE', 'LEAST(9000000,
        GREATEST(COALESCE');
    EXECUTE v_def;
  END LOOP;
END $$;