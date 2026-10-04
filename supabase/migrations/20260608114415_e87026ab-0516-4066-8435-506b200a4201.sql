CREATE OR REPLACE FUNCTION public.find_landlord_by_phone(p_phone text)
RETURNS TABLE(id uuid, name text, phone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH q AS (
    SELECT regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g') AS digits
  ), n AS (
    SELECT
      digits,
      CASE
        WHEN digits LIKE '256%' AND length(digits) >= 12 THEN '0' || substr(digits, 4)
        ELSE digits
      END AS local_digits,
      CASE
        WHEN digits LIKE '0%' AND length(digits) >= 10 THEN '256' || substr(digits, 2)
        ELSE digits
      END AS intl_digits
    FROM q
  )
  SELECT l.id, l.name, l.phone
  FROM public.landlords l, n
  WHERE length(n.digits) >= 9
    AND regexp_replace(COALESCE(l.phone, ''), '\D', '', 'g') IN (n.digits, n.local_digits, n.intl_digits)
  ORDER BY l.created_at ASC NULLS LAST
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.find_landlord_by_phone(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_landlord_by_phone(text) TO service_role;