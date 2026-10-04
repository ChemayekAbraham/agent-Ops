-- Configurable settings for the tenant phone duplicate monitor (singleton row)
CREATE TABLE IF NOT EXISTS public.tenant_phone_duplicate_settings (
  id boolean NOT NULL DEFAULT true PRIMARY KEY,
  match_digits integer NOT NULL DEFAULT 8,
  min_group_size integer NOT NULL DEFAULT 2,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_phone_dup_settings_singleton CHECK (id = true),
  CONSTRAINT tenant_phone_dup_settings_digits CHECK (match_digits BETWEEN 7 AND 9),
  CONSTRAINT tenant_phone_dup_settings_min CHECK (min_group_size BETWEEN 2 AND 50)
);

COMMENT ON TABLE public.tenant_phone_duplicate_settings IS 'Singleton config for the tenant phone near-duplicate monitor: trailing-digit signature length, minimum group size to alert, and enabled flag.';

GRANT SELECT, INSERT, UPDATE ON public.tenant_phone_duplicate_settings TO authenticated;
GRANT ALL ON public.tenant_phone_duplicate_settings TO service_role;

ALTER TABLE public.tenant_phone_duplicate_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can view duplicate settings"
  ON public.tenant_phone_duplicate_settings
  FOR SELECT TO authenticated
  USING (public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can insert duplicate settings"
  ON public.tenant_phone_duplicate_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'manager') OR public.is_ops_role(auth.uid()));

CREATE POLICY "Managers can update duplicate settings"
  ON public.tenant_phone_duplicate_settings
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'manager') OR public.is_ops_role(auth.uid()))
  WITH CHECK (public.has_role(auth.uid(), 'manager') OR public.is_ops_role(auth.uid()));

CREATE TRIGGER trg_tenant_phone_dup_settings_updated_at
  BEFORE UPDATE ON public.tenant_phone_duplicate_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed the singleton config row with defaults
INSERT INTO public.tenant_phone_duplicate_settings (id, match_digits, min_group_size, enabled)
VALUES (true, 8, 2, true)
ON CONFLICT (id) DO NOTHING;

-- Detector now reads configurable settings
CREATE OR REPLACE FUNCTION public.detect_tenant_phone_near_duplicates()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_count integer := 0;
  v_match_digits integer := 8;
  v_min_group integer := 2;
  v_enabled boolean := true;
  r record;
BEGIN
  SELECT match_digits, min_group_size, enabled
    INTO v_match_digits, v_min_group, v_enabled
  FROM public.tenant_phone_duplicate_settings
  WHERE id = true;

  -- Fall back to defaults if no settings row exists
  v_match_digits := COALESCE(v_match_digits, 8);
  v_min_group := COALESCE(v_min_group, 2);
  v_enabled := COALESCE(v_enabled, true);

  IF NOT v_enabled THEN
    RETURN 0;
  END IF;

  FOR r IN
    WITH norm AS (
      SELECT id, full_name, phone,
             regexp_replace(COALESCE(phone, ''), '\D', '', 'g') AS digits
      FROM public.profiles
      WHERE phone IS NOT NULL
        AND length(regexp_replace(COALESCE(phone, ''), '\D', '', 'g')) >= v_match_digits
    ),
    keyed AS (
      SELECT id, full_name, phone,
             right(digits, v_match_digits) AS keyk,
             right(digits, 9) AS last9
      FROM norm
    ),
    grp AS (
      SELECT keyk,
             count(DISTINCT last9) AS distinct_numbers,
             count(*)::int AS member_count,
             array_agg(id ORDER BY id) AS ids,
             (array_agg(DISTINCT full_name))[1:5] AS names,
             (array_agg(DISTINCT phone))[1:5] AS phones
      FROM keyed
      GROUP BY keyk
      HAVING count(DISTINCT last9) > 1 AND count(*) >= v_min_group
    ),
    upserted AS (
      INSERT INTO public.tenant_phone_duplicate_alerts AS t
        (signature, match_type, phone_key, member_ids, member_count, sample_names, sample_phones, status)
      SELECT 'near' || v_match_digits || ':' || keyk,
             'near_phone_last' || v_match_digits,
             keyk, ids, member_count, names, phones, 'open'
      FROM grp
      ON CONFLICT (signature) DO UPDATE SET
        member_ids   = EXCLUDED.member_ids,
        member_count = EXCLUDED.member_count,
        sample_names = EXCLUDED.sample_names,
        sample_phones = EXCLUDED.sample_phones,
        updated_at   = now(),
        status = CASE
          WHEN t.status <> 'open' AND EXCLUDED.member_count > t.member_count THEN 'open'
          ELSE t.status
        END
      RETURNING (xmax = 0) AS inserted, id, phone_key, member_count, sample_names
    )
    SELECT * FROM upserted WHERE inserted
  LOOP
    v_new_count := v_new_count + 1;
    INSERT INTO public.system_events (event_type, related_entity_type, related_entity_id, metadata)
    VALUES (
      'account_flagged',
      'tenant_phone_duplicate_alert',
      r.id,
      jsonb_build_object(
        'reason', 'tenant_phone_near_duplicate',
        'phone_key', r.phone_key,
        'member_count', r.member_count,
        'match_digits', v_match_digits,
        'sample_names', to_jsonb(r.sample_names)
      )
    );
  END LOOP;

  RETURN v_new_count;
END;
$$;