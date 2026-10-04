CREATE OR REPLACE FUNCTION public.search_landlords_fuzzy(
  p_query text DEFAULT ''::text,
  p_limit integer DEFAULT 20,
  p_threshold real DEFAULT 0.2
)
RETURNS TABLE(
  id uuid,
  name text,
  phone text,
  property_address text,
  district text,
  town_council text,
  county text,
  village text,
  house_category text,
  monthly_rent numeric,
  latitude numeric,
  longitude numeric,
  match_score real,
  match_kind text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH q AS (
    SELECT
      COALESCE(NULLIF(TRIM(p_query), ''), '') AS term,
      regexp_replace(COALESCE(p_query, ''), '\D', '', 'g') AS digits,
      greatest(COALESCE(p_threshold, 0.2), 0.05) AS thr
  ), normalized_q AS (
    SELECT
      term,
      digits,
      CASE
        WHEN digits LIKE '256%' AND length(digits) >= 12 THEN '0' || substr(digits, 4)
        ELSE digits
      END AS local_digits,
      CASE
        WHEN digits LIKE '0%' AND length(digits) >= 10 THEN '256' || substr(digits, 2)
        ELSE digits
      END AS intl_digits,
      thr
    FROM q
  ), scored AS (
    SELECT
      l.id, l.name, l.phone, l.property_address, l.district, l.town_council,
      l.county, l.village, l.house_category, l.monthly_rent, l.latitude, l.longitude,
      q.term, q.digits, q.local_digits, q.intl_digits, q.thr,
      regexp_replace(COALESCE(l.phone, ''), '\D', '', 'g') AS landlord_digits,
      (l.name ILIKE '%' || q.term || '%') AS name_substr,
      (q.term <> '' AND l.phone ILIKE '%' || q.term || '%') AS phone_substr,
      greatest(similarity(l.name, q.term), word_similarity(q.term, l.name)) AS name_sim
    FROM public.landlords l, normalized_q q
  ), matched AS (
    SELECT
      s.*,
      (
        length(s.digits) >= 3
        AND (
          s.landlord_digits ILIKE '%' || s.digits || '%'
          OR s.landlord_digits ILIKE '%' || s.local_digits || '%'
          OR s.landlord_digits ILIKE '%' || s.intl_digits || '%'
        )
      ) AS phone_digit
    FROM scored s
  )
  SELECT
    s.id, s.name, s.phone, s.property_address, s.district, s.town_council,
    s.county, s.village, s.house_category, s.monthly_rent, s.latitude, s.longitude,
    CASE WHEN s.term = '' THEN 1::real ELSE round(s.name_sim::numeric, 3)::real END AS match_score,
    CASE
      WHEN s.term = '' THEN 'all'
      WHEN s.name_substr THEN 'name_exact'
      WHEN s.phone_substr OR s.phone_digit THEN 'phone'
      ELSE 'fuzzy'
    END AS match_kind
  FROM matched s
  WHERE
    s.term = ''
    OR s.name_substr
    OR s.phone_substr
    OR s.phone_digit
    OR s.name_sim >= s.thr
  ORDER BY
    CASE
      WHEN s.term = '' THEN 0
      WHEN s.name_substr THEN 1
      WHEN s.phone_substr OR s.phone_digit THEN 2
      ELSE 3
    END,
    s.name_sim DESC,
    s.name ASC
  LIMIT greatest(COALESCE(p_limit, 20), 1);
$$;