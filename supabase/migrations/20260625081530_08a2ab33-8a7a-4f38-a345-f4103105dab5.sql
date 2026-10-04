-- Strict, canonical phone normalization + validation for profiles.
-- Root cause: lenient normalizers turned malformed local numbers (e.g. the
-- 11-digit "07827277378") into invalid "+256..." values that broke login
-- resolution. This enforces a single canonical E.164 form and rejects
-- anything that can't be coerced to a valid number, on every write path.

CREATE OR REPLACE FUNCTION public.normalize_e164_phone(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  s        text;
  had_plus boolean;
  d        text;
  national text;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  s := btrim(raw);
  IF s = '' THEN RETURN NULL; END IF;

  had_plus := left(s, 1) = '+';
  d := regexp_replace(s, '\D', '', 'g');   -- digits only
  IF d = '' THEN RETURN NULL; END IF;

  -- Ugandan local form: leading 0, no country code (e.g. 0771234567)
  IF NOT had_plus AND left(d, 1) = '0' THEN
    national := regexp_replace(substring(d FROM 2), '^0+', '');  -- drop leading zeros
    IF length(national) = 9 THEN
      RETURN '+256' || national;
    END IF;
    RETURN NULL;  -- malformed local (e.g. 11-digit 07827277378 -> 10 national digits)
  END IF;

  -- Uganda country code, with or without + (e.g. 256771234567 / 2560771234567)
  IF left(d, 3) = '256' THEN
    national := regexp_replace(substring(d FROM 4), '^0+', '');
    IF length(national) = 9 THEN
      RETURN '+256' || national;
    END IF;
    RETURN NULL;  -- malformed 256 number
  END IF;

  -- Bare 9-digit Ugandan number without any prefix (e.g. 771234567)
  IF NOT had_plus AND length(d) = 9 THEN
    RETURN '+256' || d;
  END IF;

  -- Explicit international number: + followed by 9-15 digits (foreign supporters)
  IF had_plus AND length(d) BETWEEN 9 AND 15 THEN
    RETURN '+' || d;
  END IF;

  RETURN NULL;  -- not coercible to a valid phone number
END;
$$;

GRANT EXECUTE ON FUNCTION public.normalize_e164_phone(text) TO anon, authenticated, service_role;

-- Trigger: normalize valid phones to canonical form, hard-reject malformed ones.
CREATE OR REPLACE FUNCTION public.trg_normalize_validate_profile_phone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_norm text;
BEGIN
  -- Empty/blank -> store NULL (phone is optional for some accounts)
  IF NEW.phone IS NULL OR btrim(NEW.phone) = '' THEN
    NEW.phone := NULL;
    RETURN NEW;
  END IF;

  -- On UPDATE, only validate when the phone actually changes. This leaves
  -- historical (legacy) rows untouched when other columns are edited.
  IF TG_OP = 'UPDATE' AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
    RETURN NEW;
  END IF;

  v_norm := public.normalize_e164_phone(NEW.phone);
  IF v_norm IS NULL THEN
    RAISE EXCEPTION 'invalid_phone_number: "%" is not a valid phone number', NEW.phone
      USING ERRCODE = 'check_violation',
            HINT = 'Use a valid Ugandan number (07XXXXXXXX or +2567XXXXXXXX) or an international number as +<countrycode><number>.';
  END IF;

  NEW.phone := v_norm;  -- store the canonical E.164 value
  RETURN NEW;
END;
$$;

-- Name sorts before trg_prevent_duplicate_phone_* so normalization happens
-- BEFORE the duplicate check sees the value.
DROP TRIGGER IF EXISTS trg_normalize_validate_phone_insert ON public.profiles;
DROP TRIGGER IF EXISTS trg_normalize_validate_phone_update ON public.profiles;

CREATE TRIGGER trg_normalize_validate_phone_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_normalize_validate_profile_phone();

CREATE TRIGGER trg_normalize_validate_phone_update
  BEFORE UPDATE OF phone ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_normalize_validate_profile_phone();