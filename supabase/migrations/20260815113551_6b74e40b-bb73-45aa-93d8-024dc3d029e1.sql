CREATE OR REPLACE FUNCTION public.get_cfo_cash_movement_rows(
  p_from timestamptz DEFAULT NULL,
  p_after timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 5000
)
RETURNS TABLE (
  id uuid,
  transaction_date timestamptz,
  amount numeric,
  direction text,
  category text,
  ledger_scope text,
  classification text,
  reference_id text,
  description text,
  linked_party text,
  user_id uuid,
  transaction_group_id uuid,
  source_table text,
  source_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role::text IN ('cfo','ceo','coo','manager','super_admin','financial_ops')
  ) THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  RETURN QUERY
  SELECT gl.id, gl.transaction_date, gl.amount, gl.direction, gl.category,
         gl.ledger_scope, gl.classification, gl.reference_id, gl.description,
         gl.linked_party, gl.user_id, gl.transaction_group_id,
         gl.source_table, gl.source_id
  FROM public.general_ledger gl
  WHERE (p_from IS NULL OR gl.transaction_date >= p_from)
    AND (p_after IS NULL OR gl.transaction_date >= p_after)
  ORDER BY gl.transaction_date ASC, gl.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 5000), 1), 10000);
END;
$$;

REVOKE ALL ON FUNCTION public.get_cfo_cash_movement_rows(timestamptz, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_cfo_cash_movement_rows(timestamptz, timestamptz, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_cash_movement_rows(timestamptz, timestamptz, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cfo_cash_movement_rows(timestamptz, timestamptz, integer) TO service_role;