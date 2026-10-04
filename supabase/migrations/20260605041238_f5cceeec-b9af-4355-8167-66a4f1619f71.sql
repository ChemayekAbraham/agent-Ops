-- ============================================
-- UNIQUE PHONE CONSTRAINT — Tenant Duplicate Prevention
-- ============================================
-- Prevents creation of duplicate tenant (or any) records
-- even when UI validation is bypassed or race conditions occur.

-- 1. Normalization helper (idempotent)
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

COMMENT ON FUNCTION public.normalize_phone_last9 IS 'Strips non-digits and returns the last 9 digits of a phone number for deduplication. Used by idx_profiles_phone_normalized.';

-- 2. Unique index on normalized phone (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_phone_normalized
ON public.profiles (normalize_phone_last9(phone))
WHERE normalize_phone_last9(phone) IS NOT NULL;

-- 3. BEFORE INSERT trigger for human-readable error on duplicate phone
--    This runs *before* the unique index fires, giving a cleaner error
--    message and letting edge functions detect the specific problem.
CREATE OR REPLACE FUNCTION public.trg_prevent_duplicate_phone_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_last9 text;
  v_existing uuid;
BEGIN
  v_last9 := public.normalize_phone_last9(NEW.phone);
  IF v_last9 IS NULL THEN
    RETURN NEW; -- no phone to deduplicate
  END IF;

  SELECT id INTO v_existing
  FROM public.profiles
  WHERE normalize_phone_last9(phone) = v_last9
    AND id <> COALESCE(NEW.id, gen_random_uuid()) -- exclude self on updates
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'phone_already_registered: % is already linked to profile %', NEW.phone, v_existing
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trg_prevent_duplicate_phone_insert ON public.profiles;
CREATE TRIGGER trg_prevent_duplicate_phone_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_prevent_duplicate_phone_insert();
