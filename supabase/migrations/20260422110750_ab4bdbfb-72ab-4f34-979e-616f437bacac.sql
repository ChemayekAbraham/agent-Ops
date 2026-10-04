
-- 1. Backfill the 10 existing too-short names so the trigger doesn't trip on legacy rows.
--    Strategy: derive a placeholder from email local-part or last 4 digits of phone,
--    so dashboards stop showing "Unknown" / single letters.
UPDATE public.profiles p
SET full_name = COALESCE(
  NULLIF(btrim(split_part(p.email, '@', 1)), ''),
  CASE
    WHEN p.phone IS NOT NULL AND length(regexp_replace(p.phone, '\D', '', 'g')) >= 4
      THEN 'User ' || right(regexp_replace(p.phone, '\D', '', 'g'), 4)
    ELSE 'User ' || substr(p.id::text, 1, 6)
  END
)
WHERE p.full_name IS NULL
   OR length(btrim(regexp_replace(p.full_name, '\s+', ' ', 'g'))) < 2;

-- 2. Server-side validator: trims surrounding whitespace, collapses internal whitespace,
--    and rejects anything shorter than 2 visible characters. Mirrors the client helper
--    in src/lib/authValidation.ts (validateFullName).
CREATE OR REPLACE FUNCTION public.enforce_profile_full_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cleaned TEXT;
BEGIN
  IF NEW.full_name IS NULL THEN
    RAISE EXCEPTION 'Full name is required (minimum 2 characters)'
      USING ERRCODE = '23514';
  END IF;

  -- Trim + collapse internal whitespace
  cleaned := btrim(regexp_replace(NEW.full_name, '\s+', ' ', 'g'));

  IF length(cleaned) < 2 THEN
    RAISE EXCEPTION 'Full name is required (minimum 2 characters)'
      USING ERRCODE = '23514';
  END IF;

  -- Persist the normalized value so we never store leading/trailing/duplicate whitespace
  NEW.full_name := cleaned;
  RETURN NEW;
END;
$$;

-- 3. Wire trigger to BOTH inserts and updates of full_name on profiles.
DROP TRIGGER IF EXISTS enforce_profile_full_name_insert ON public.profiles;
CREATE TRIGGER enforce_profile_full_name_insert
BEFORE INSERT ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.enforce_profile_full_name();

DROP TRIGGER IF EXISTS enforce_profile_full_name_update ON public.profiles;
CREATE TRIGGER enforce_profile_full_name_update
BEFORE UPDATE OF full_name ON public.profiles
FOR EACH ROW
WHEN (NEW.full_name IS DISTINCT FROM OLD.full_name)
EXECUTE FUNCTION public.enforce_profile_full_name();
