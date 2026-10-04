-- Create function to extract last 9 digits for normalization
CREATE OR REPLACE FUNCTION public.normalize_phone_last9(phone text)
RETURNS text AS $$
DECLARE
  digits text;
BEGIN
  IF phone IS NULL THEN RETURN NULL; END IF;
  digits := regexp_replace(phone, '\D', '', 'g');
  IF length(digits) >= 9 THEN
    RETURN right(digits, 9);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create unique index on normalized phone for profiles
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_phone_normalized 
ON public.profiles (normalize_phone_last9(phone)) 
WHERE normalize_phone_last9(phone) IS NOT NULL;

-- Create unique index on normalized phone for pending invites
CREATE UNIQUE INDEX IF NOT EXISTS idx_supporter_invites_phone_normalized 
ON public.supporter_invites (normalize_phone_last9(phone)) 
WHERE status = 'pending' AND normalize_phone_last9(phone) IS NOT NULL;