CREATE OR REPLACE FUNCTION public.generate_landlord_receipt_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  src text := upper(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
  result text := '';
  i int;
  b int;
BEGIN
  -- 10 chars from a 32-char unambiguous alphabet (~50 bits) sourced from two
  -- v4 UUIDs. Avoids pgcrypto, which is not on this function's search_path.
  FOR i IN 1..10 LOOP
    b := ascii(substr(src, i * 3, 1)) + ascii(substr(src, i * 3 + 1, 1)) * 7 + i * 13;
    result := result || substr(chars, 1 + (b % length(chars)), 1);
  END LOOP;
  RETURN result;
END;
$$;