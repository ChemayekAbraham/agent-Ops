-- Normalize tenant district assignments. Entebbe is a city under Wakiso
-- District, so any attempt to set district = 'Entebbe' (in any casing) is
-- silently rewritten to 'Wakiso'. Other district values are trimmed so
-- accidental whitespace cannot create phantom districts.

CREATE OR REPLACE FUNCTION public.normalize_profile_district()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_clean text;
BEGIN
  IF NEW.district IS NULL THEN
    RETURN NEW;
  END IF;

  v_clean := btrim(NEW.district);

  IF v_clean = '' THEN
    NEW.district := NULL;
    RETURN NEW;
  END IF;

  -- Entebbe → Wakiso (Entebbe is a city under Wakiso District)
  IF lower(v_clean) = 'entebbe' THEN
    NEW.district := 'Wakiso';
    RETURN NEW;
  END IF;

  -- Title-case well-known Uganda districts so casing variants collapse.
  IF lower(v_clean) IN (
    'kampala','wakiso','mpigi','mukono','jinja','mbale','mbarara',
    'gulu','lira','arua','kasese','kabale','soroti','masaka','hoima',
    'fort portal','kyengera','nakasongola','entebbe'
  ) THEN
    NEW.district := initcap(lower(v_clean));
    -- Re-apply Entebbe → Wakiso after normalization just in case.
    IF NEW.district = 'Entebbe' THEN
      NEW.district := 'Wakiso';
    END IF;
  ELSE
    NEW.district := v_clean;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_profile_district ON public.profiles;

CREATE TRIGGER trg_normalize_profile_district
BEFORE INSERT OR UPDATE OF district ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.normalize_profile_district();