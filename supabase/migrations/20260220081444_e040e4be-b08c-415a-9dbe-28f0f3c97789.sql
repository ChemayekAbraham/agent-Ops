-- Create a SECURITY DEFINER function to look up email(s) by phone number variants
-- This bypasses RLS safely since it only returns email (not sensitive data) for authentication purposes
CREATE OR REPLACE FUNCTION public.get_email_by_phone(phone_variants text[])
RETURNS TABLE(email text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT p.email
  FROM profiles p
  WHERE p.phone = ANY(phone_variants)
  LIMIT 5;
END;
$$;

-- Allow unauthenticated (anon) users to call this function for sign-in
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text[]) TO anon;
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text[]) TO authenticated;