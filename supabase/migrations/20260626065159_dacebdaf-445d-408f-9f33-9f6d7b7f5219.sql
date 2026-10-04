-- Centralized landlord duplicate detection: matches by phone number OR by
-- case-insensitive (trimmed, whitespace-normalized) name so agents are warned
-- before creating a duplicate landlord record from any flow (house listing,
-- tenant rent request, agent/tenant registration).
CREATE OR REPLACE FUNCTION public.find_landlord_duplicate(p_name text, p_phone text)
RETURNS TABLE(id uuid, name text, phone text, matched_on text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH q AS (
    SELECT
      regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g') AS digits,
      lower(regexp_replace(trim(COALESCE(p_name, '')), '\s+', ' ', 'g')) AS norm_name
  ), n AS (
    SELECT
      digits,
      norm_name,
      CASE
        WHEN digits LIKE '256%' AND length(digits) >= 12 THEN '0' || substr(digits, 4)
        ELSE digits
      END AS local_digits,
      CASE
        WHEN digits LIKE '0%' AND length(digits) >= 10 THEN '256' || substr(digits, 2)
        ELSE digits
      END AS intl_digits
    FROM q
  ), matches AS (
    SELECT
      l.id,
      l.name,
      l.phone,
      (length(n.digits) >= 9
        AND regexp_replace(COALESCE(l.phone, ''), '\D', '', 'g') IN (n.digits, n.local_digits, n.intl_digits)) AS phone_match,
      (length(n.norm_name) >= 2
        AND lower(regexp_replace(trim(COALESCE(l.name, '')), '\s+', ' ', 'g')) = n.norm_name) AS name_match,
      l.created_at
    FROM public.landlords l, n
  )
  SELECT
    m.id,
    m.name,
    m.phone,
    CASE
      WHEN m.phone_match AND m.name_match THEN 'both'
      WHEN m.phone_match THEN 'phone'
      ELSE 'name'
    END AS matched_on
  FROM matches m
  WHERE m.phone_match OR m.name_match
  -- Prefer the strongest signal (both > phone > name), then the oldest record.
  ORDER BY (m.phone_match AND m.name_match) DESC, m.phone_match DESC, m.created_at ASC NULLS LAST
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.find_landlord_duplicate(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_landlord_duplicate(text, text) TO service_role;