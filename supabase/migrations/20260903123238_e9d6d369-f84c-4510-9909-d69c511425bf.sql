DO $do$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_promissory_ops_report';
  IF d IS NULL THEN RAISE EXCEPTION 'get_promissory_ops_report missing'; END IF;
  IF position('ROUND(COALESCE(portfolio_amount, 0) * v_rate_creation)' in d) = 0 THEN
    RAISE EXCEPTION 'expected commission anchor not found';
  END IF;
  d := replace(d,
    'ROUND(COALESCE(portfolio_amount, 0) * v_rate_creation)',
    'ROUND(COALESCE(amount, 0) * v_rate_creation)');
  EXECUTE d;
END $do$;

DO $do$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'credit_promissory_agent_commission';
  IF d IS NULL THEN RAISE EXCEPTION 'credit_promissory_agent_commission missing'; END IF;
  IF position('v_amount := round(p_base_amount * v_rate);' in d) = 0 THEN
    RAISE EXCEPTION 'commission base anchor not found';
  END IF;
  d := replace(d,
    'v_amount := round(p_base_amount * v_rate);',
    'IF p_kind = ''portfolio_creation'' THEN
    SELECT LEAST(p_base_amount, GREATEST(COALESCE(pn.amount, 0), 0))
      INTO p_base_amount
      FROM public.promissory_notes pn
     WHERE pn.id = v_note_id;
    IF coalesce(p_base_amount,0) <= 0 THEN
      RETURN jsonb_build_object(''status'',''skipped'',''reason'',''note_amount_zero'');
    END IF;
  END IF;

  v_amount := round(p_base_amount * v_rate);');
  EXECUTE d;
END $do$;