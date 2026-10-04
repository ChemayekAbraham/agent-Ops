CREATE OR REPLACE FUNCTION public.enforce_uganda_house_region()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_region_key text;
  v_district_key text;
  v_d2r jsonb := '{
    "kampala":"Central","wakiso":"Central","mukono":"Central","mpigi":"Central",
    "masaka":"Central","entebbe":"Central","nansana":"Central","kira":"Central",
    "bweyogerere":"Central","kyengera":"Central","luwero":"Central","mityana":"Central",
    "mubende":"Central","nakasongola":"Central","kayunga":"Central","buikwe":"Central",
    "butambala":"Central","gomba":"Central","kalangala":"Central","kyankwanzi":"Central",
    "lwengo":"Central","lyantonde":"Central","rakai":"Central","sembabule":"Central",
    "jinja":"Eastern","mbale":"Eastern","soroti":"Eastern","iganga":"Eastern",
    "tororo":"Eastern","busia":"Eastern","kapchorwa":"Eastern","pallisa":"Eastern",
    "gulu":"Northern","lira":"Northern","arua":"Northern","kitgum":"Northern",
    "pader":"Northern","moyo":"Northern","nebbi":"Northern","adjumani":"Northern",
    "mbarara":"Western","kabale":"Western","kasese":"Western","hoima":"Western",
    "fort portal":"Western","kabarole":"Western","bushenyi":"Western",
    "ntungamo":"Western","rukungiri":"Western","kanungu":"Western","ibanda":"Western"
  }'::jsonb;
  v_c2d jsonb := '{
    "entebbe":"Wakiso","nansana":"Wakiso","kira":"Wakiso",
    "bweyogerere":"Wakiso","kyengera":"Wakiso"
  }'::jsonb;
BEGIN
  IF NEW.region IS NOT NULL THEN
    NEW.region := trim(NEW.region);
    IF NEW.region = '' THEN NEW.region := NULL; END IF;
  END IF;
  IF NEW.district IS NOT NULL THEN
    NEW.district := trim(NEW.district);
    IF NEW.district = '' THEN NEW.district := NULL; END IF;
  END IF;

  -- Roll up city → parent district
  IF NEW.district IS NOT NULL THEN
    v_district_key := lower(regexp_replace(NEW.district, '\s+district$', '', 'i'));
    IF v_c2d ? v_district_key THEN
      NEW.district := v_c2d ->> v_district_key;
    END IF;
  END IF;

  IF NEW.region IS NOT NULL THEN
    v_region_key := lower(regexp_replace(NEW.region, '\s+region$', '', 'i'));

    IF v_region_key = ANY(ARRAY['central','eastern','northern','western']) THEN
      NEW.region := initcap(v_region_key);
    ELSIF v_d2r ? v_region_key THEN
      -- A district/city was stored in `region`. Shift to district if empty
      IF NEW.district IS NULL THEN
        IF v_c2d ? v_region_key THEN
          NEW.district := v_c2d ->> v_region_key;
        ELSE
          NEW.district := initcap(v_region_key);
        END IF;
      END IF;
      NEW.region := v_d2r ->> v_region_key;
    ELSE
      RAISE EXCEPTION
        'Invalid region "%". Allowed: Central, Eastern, Northern, Western (or a known Uganda district/city).',
        NEW.region
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Derive region from district if region is still missing
  IF NEW.region IS NULL AND NEW.district IS NOT NULL THEN
    v_district_key := lower(NEW.district);
    IF v_d2r ? v_district_key THEN
      NEW.region := v_d2r ->> v_district_key;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_uganda_house_region ON public.house_listings;
CREATE TRIGGER trg_enforce_uganda_house_region
BEFORE INSERT OR UPDATE OF region, district ON public.house_listings
FOR EACH ROW
EXECUTE FUNCTION public.enforce_uganda_house_region();

COMMENT ON FUNCTION public.enforce_uganda_house_region IS
'Validates/normalizes house_listings region & district. Rejects unknown region strings; auto-shifts district/city names placed in region into the district column and assigns the correct Uganda administrative region (Central/Eastern/Northern/Western).';