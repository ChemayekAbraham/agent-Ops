CREATE OR REPLACE FUNCTION public.enforce_uganda_house_region()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_region_key text;
  v_district_key text;
  v_in_region text := NEW.region;
  v_in_district text := NEW.district;
  v_changed_fields text[] := ARRAY[]::text[];
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

  IF NEW.region IS NULL AND NEW.district IS NOT NULL THEN
    v_district_key := lower(NEW.district);
    IF v_d2r ? v_district_key THEN
      NEW.region := v_d2r ->> v_district_key;
    END IF;
  END IF;

  -- Detect what we actually changed (NULL-safe) — use array_append, NOT || on text
  IF NEW.region IS DISTINCT FROM v_in_region THEN
    v_changed_fields := array_append(v_changed_fields, 'region');
  END IF;
  IF NEW.district IS DISTINCT FROM v_in_district THEN
    v_changed_fields := array_append(v_changed_fields, 'district');
  END IF;

  IF array_length(v_changed_fields, 1) IS NOT NULL THEN
    BEGIN
      INSERT INTO public.audit_logs (
        user_id, action_type, table_name, record_id, action, metadata
      ) VALUES (
        auth.uid(),
        'house_region_normalized',
        'house_listings',
        NEW.id::text,
        'auto_normalize',
        jsonb_build_object(
          'reason', 'auto_normalize',
          'trigger', 'enforce_uganda_house_region',
          'operation', TG_OP,
          'changed_fields', to_jsonb(v_changed_fields),
          'original', jsonb_build_object('region', v_in_region, 'district', v_in_district),
          'normalized', jsonb_build_object('region', NEW.region, 'district', NEW.district)
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'audit_logs insert failed in enforce_uganda_house_region: %', SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$;