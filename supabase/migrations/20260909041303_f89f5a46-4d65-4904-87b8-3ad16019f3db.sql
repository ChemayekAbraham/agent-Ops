CREATE OR REPLACE FUNCTION public.enforce_rent_request_landlord_agreement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Signed landlord agreement is now OPTIONAL everywhere, including when an
  -- agent posts a brand-new rent request. The trigger remains attached for
  -- backward compatibility but no longer blocks inserts.
  RETURN NEW;
END;
$$;