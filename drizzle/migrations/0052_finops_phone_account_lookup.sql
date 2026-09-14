-- Financial Ops: for any phone number, say whether it belongs to a Welile account.
-- Matches on the last 9 digits (the platform-wide way of comparing Ugandan numbers).
CREATE OR REPLACE FUNCTION public.finops_phone_account_lookup(p_phones text[])
RETURNS TABLE(phone_key text, has_account boolean, account_name text, account_user_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'super_admin')
    OR public.has_role(v_uid, 'manager')
  ) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;

  RETURN QUERY
  WITH wanted AS (
    SELECT DISTINCT right(regexp_replace(coalesce(ph, ''), '\\D', '', 'g'), 9) AS k
    FROM unnest(coalesce(p_phones, ARRAY[]::text[])) AS ph
  ), matched AS (
    SELECT DISTINCT ON (w2.k)
      w2.k,
      pr.full_name,
      pr.id
    FROM wanted w2
    JOIN public.profiles pr
      ON right(regexp_replace(coalesce(pr.phone, ''), '\\D', '', 'g'), 9) = w2.k
     AND w2.k <> ''
    ORDER BY w2.k, pr.created_at ASC NULLS LAST
  )
  SELECT w3.k,
         (m.k IS NOT NULL),
         m.full_name,
         m.id
  FROM wanted w3
  LEFT JOIN matched m ON m.k = w3.k
  WHERE w3.k <> '';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.finops_phone_account_lookup(text[]) TO authenticated;