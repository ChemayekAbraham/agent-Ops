CREATE OR REPLACE FUNCTION public.match_email_ledger_credits(p_refs text[])
RETURNS TABLE (
  ref text,
  ledger_id uuid,
  amount numeric,
  category text,
  ledger_scope text,
  user_id uuid,
  user_name text,
  user_phone text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  WITH refs AS (
    SELECT DISTINCT
      r AS ref,
      regexp_replace(r, '\D', '', 'g') AS digits
    FROM unnest(coalesce(p_refs, '{}'::text[])) AS r
    WHERE r IS NOT NULL AND btrim(r) <> ''
  )
  SELECT
    f.ref,
    l.id,
    l.amount,
    l.category,
    l.ledger_scope,
    l.user_id,
    pr.full_name,
    pr.phone,
    l.created_at
  FROM refs f
  JOIN general_ledger l
    ON length(f.digits) >= 6
   AND (
     l.reference_id = f.ref
     OR l.idempotency_key ILIKE '%' || f.digits || '%'
     OR l.description ILIKE '%' || f.digits || '%'
   )
  LEFT JOIN profiles pr ON pr.id = l.user_id
  WHERE l.direction = 'cash_in'
    AND coalesce(l.classification, '') <> 'admin_correction'
    AND l.created_at >= now() - interval '180 days';
END;
$$;

REVOKE ALL ON FUNCTION public.match_email_ledger_credits(text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.match_email_ledger_credits(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_email_ledger_credits(text[]) TO service_role;