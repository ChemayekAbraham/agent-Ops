DO $do$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.special_advance_add_topup(uuid,timestamptz,jsonb)'::regprocedure);
  IF position('''source_id'', v_id, ''reference_id'', a.reference' in d) = 0 THEN
    RAISE EXCEPTION 'special_advance_add_topup changed; expected text not found';
  END IF;
  d := replace(d, '''source_id'', v_id, ''reference_id'', a.reference', '''source_id'', v_id, ''reference_id'', v_tref');
  EXECUTE d;
END $do$;