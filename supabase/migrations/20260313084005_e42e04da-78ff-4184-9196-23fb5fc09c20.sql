
-- Create a database function to detect duplicate phone numbers server-side
-- This scales to millions of users unlike the client-side approach
CREATE OR REPLACE FUNCTION public.find_duplicate_phones()
RETURNS TABLE(normalized_phone text, user_ids uuid[], user_count int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    right(regexp_replace(phone, '\D', '', 'g'), 9) AS normalized_phone,
    array_agg(id ORDER BY created_at) AS user_ids,
    count(*)::int AS user_count
  FROM public.profiles
  WHERE phone IS NOT NULL 
    AND length(regexp_replace(phone, '\D', '', 'g')) >= 9
  GROUP BY right(regexp_replace(phone, '\D', '', 'g'), 9)
  HAVING count(*) > 1
  ORDER BY count(*) DESC
  LIMIT 500;
$$;
