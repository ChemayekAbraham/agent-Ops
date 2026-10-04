DO $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT public.run_layer_a_bulk(false) INTO v_result;
  RAISE NOTICE 'Layer A bulk result: %', v_result;
END $$;