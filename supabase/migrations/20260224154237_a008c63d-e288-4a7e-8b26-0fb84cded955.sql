-- Create a helper function to check if a phone number exists in profiles
-- Uses the last 9 digits for matching to handle all Ugandan phone formats
CREATE OR REPLACE FUNCTION public.check_phone_exists(phone_suffix text)
RETURNS TABLE(id uuid, full_name text) 
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.full_name 
  FROM profiles p 
  WHERE RIGHT(regexp_replace(p.phone, '\D', '', 'g'), 9) = phone_suffix
  LIMIT 1;
$$;