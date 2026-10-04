-- 1) Canonical Ugandan phone normalizer. Returns "256XXXXXXXXX" (no '+') for
--    any accepted Ugandan mobile shape, or NULL for anything else (including
--    foreign numbers, landlines, and unparseable input).
CREATE OR REPLACE FUNCTION public.normalize_ug_phone(raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  digits TEXT;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  digits := regexp_replace(raw, '\D', '', 'g');
  IF digits = '' THEN RETURN NULL; END IF;

  IF digits ~ '^256[3-9][0-9]{8}$' THEN
    RETURN digits;
  ELSIF digits ~ '^0[3-9][0-9]{8}$' THEN
    RETURN '256' || substring(digits FROM 2);
  ELSIF digits ~ '^[3-9][0-9]{8}$' THEN
    RETURN '256' || digits;
  END IF;
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.normalize_ug_phone(TEXT) TO anon, authenticated, service_role;

-- 2) Backfill profiles.phone to the canonical "+256XXXXXXXXX" form for every
--    row whose current phone parses as a valid Ugandan mobile. Foreign numbers
--    (e.g. Kenya/Nigeria/Egypt) are left exactly as they were.
UPDATE public.profiles
SET phone = '+' || public.normalize_ug_phone(phone)
WHERE phone IS NOT NULL
  AND phone <> ''
  AND public.normalize_ug_phone(phone) IS NOT NULL
  AND phone <> '+' || public.normalize_ug_phone(phone);

-- 3) Partial UNIQUE index on the normalized Ugandan form so two profiles can
--    never share the same Ugandan mobile number. Foreign numbers are excluded
--    from the constraint (index predicate returns NULL for them).
CREATE UNIQUE INDEX IF NOT EXISTS profiles_phone_ug_e164_unique
  ON public.profiles (public.normalize_ug_phone(phone))
  WHERE public.normalize_ug_phone(phone) IS NOT NULL;