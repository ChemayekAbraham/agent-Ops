DO $do$
DECLARE d text := pg_get_functiondef('public.sofp_ledger_legs(timestamp with time zone)'::regprocedure);
BEGIN
  d := replace(d, 'public.sofp_ledger_legs(p_as_at timestamp with time zone)',
                  'public.sofp_ledger_legs_window(p_from timestamp with time zone, p_as_at timestamp with time zone)');
  d := replace(d, 'WITH grp_class AS MATERIALIZED (', 'WITH win AS MATERIALIZED (
    SELECT DISTINCT w.transaction_group_id FROM general_ledger w
    WHERE w.transaction_date >= p_from AND w.transaction_date <= p_as_at AND w.transaction_group_id IS NOT NULL
  ), grp_class AS MATERIALIZED (');
  d := replace(d, 'WHERE gl.transaction_group_id IS NOT NULL
', 'WHERE gl.transaction_group_id IN (SELECT transaction_group_id FROM win)
');
  d := replace(d, 'WHERE gl.transaction_date <= p_as_at', 'WHERE gl.transaction_date <= p_as_at
      AND (gl.transaction_group_id IN (SELECT transaction_group_id FROM win)
           OR (gl.transaction_group_id IS NULL AND gl.transaction_date >= p_from))');
  IF (length(d) - length(replace(d, 'FROM win)', ''))) / length('FROM win)') <> 2
     OR position('sofp_ledger_legs_window' in d) = 0 THEN
    RAISE EXCEPTION 'sofp_ledger_legs_window: source patch did not apply';
  END IF;
  EXECUTE d;
END $do$;

REVOKE ALL ON FUNCTION public.sofp_ledger_legs_window(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sofp_ledger_legs_window(timestamptz, timestamptz) TO service_role;
COMMENT ON FUNCTION public.sofp_ledger_legs_window(timestamptz, timestamptz) IS
  'Same resolution as sofp_ledger_legs(p_as_at), limited to transaction groups with a leg dated in [p_from, p_as_at] (plus ungrouped legs in that range). Rows dated inside the window are identical to the full function. Used by fin_income_statement.';

DO $do$
DECLARE d text := pg_get_functiondef('public.fin_income_statement(timestamp with time zone, timestamp with time zone)'::regprocedure);
BEGIN
  IF position('public.sofp_ledger_legs(p_to - interval ''1 microsecond'')' in d) = 0 THEN
    RAISE EXCEPTION 'fin_income_statement: expected call not found';
  END IF;
  d := replace(d, 'public.sofp_ledger_legs(p_to - interval ''1 microsecond'')',
                  'public.sofp_ledger_legs_window(p_from, p_to - interval ''1 microsecond'')');
  EXECUTE d;
END $do$;