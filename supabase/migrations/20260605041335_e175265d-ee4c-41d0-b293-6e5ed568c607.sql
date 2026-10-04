-- ============================================
-- UNIQUE PHONE CONSTRAINT — UPDATE PATH
-- ============================================
-- Prevents changing a profile's phone to a number already held
-- by another profile, even on direct SQL updates.

CREATE OR REPLACE FUNCTION public.trg_prevent_duplicate_phone_update()
RETURNS TRIGGER AS $$
DECLARE
  v_last9 text;
  v_existing uuid;
BEGIN
  -- Only check when phone is actually changing
  IF NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
    RETURN NEW;
  END IF;

  v_last9 := public.normalize_phone_last9(NEW.phone);
  IF v_last9 IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_existing
  FROM public.profiles
  WHERE normalize_phone_last9(phone) = v_last9
    AND id <> NEW.id
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

DROP TRIGGER IF EXISTS trg_prevent_duplicate_phone_update ON public.profiles;
CREATE TRIGGER trg_prevent_duplicate_phone_update
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_prevent_duplicate_phone_update();