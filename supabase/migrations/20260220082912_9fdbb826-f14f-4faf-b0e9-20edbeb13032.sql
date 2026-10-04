-- Upgrade get_email_by_phone to match by last 9 digits (handles all format variations)
CREATE OR REPLACE FUNCTION public.get_email_by_phone(phone_variants text[])
RETURNS TABLE(email text) 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  last9_variants text[];
  v text;
  cleaned text;
BEGIN
  -- Build array of last-9-digit suffixes from all provided variants
  last9_variants := ARRAY[]::text[];
  FOREACH v IN ARRAY phone_variants LOOP
    cleaned := regexp_replace(v, '[^0-9]', '', 'g');
    IF length(cleaned) >= 9 THEN
      last9_variants := array_append(last9_variants, right(cleaned, 9));
    END IF;
  END LOOP;

  -- Match profiles where last 9 digits of stored phone match any variant
  RETURN QUERY
  SELECT DISTINCT p.email
  FROM profiles p
  WHERE length(regexp_replace(p.phone, '[^0-9]', '', 'g')) >= 9
    AND right(regexp_replace(p.phone, '[^0-9]', '', 'g'), 9) = ANY(last9_variants)
  LIMIT 10;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text[]) TO anon;
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text[]) TO authenticated;