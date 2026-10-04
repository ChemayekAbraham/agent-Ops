-- Recurring monitor for tenant phone near-duplicates
CREATE TABLE IF NOT EXISTS public.tenant_phone_duplicate_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  signature text NOT NULL UNIQUE,
  match_type text NOT NULL DEFAULT 'near_phone_last8',
  phone_key text NOT NULL,
  member_ids uuid[] NOT NULL DEFAULT '{}',
  member_count integer NOT NULL DEFAULT 0,
  sample_names text[] NOT NULL DEFAULT '{}',
  sample_phones text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open',
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tenant_phone_duplicate_alerts IS 'Recurring monitor output: groups of tenant profiles whose phone numbers are near-duplicates (share the last 8 digits but differ on the full normalized number), indicating possible typos or fraudulent re-registration.';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_phone_duplicate_alerts TO authenticated;
GRANT ALL ON public.tenant_phone_duplicate_alerts TO service_role;

ALTER TABLE public.tenant_phone_duplicate_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can view duplicate alerts"
  ON public.tenant_phone_duplicate_alerts
  FOR SELECT TO authenticated
  USING (public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Ops can update duplicate alerts"
  ON public.tenant_phone_duplicate_alerts
  FOR UPDATE TO authenticated
  USING (public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'));

CREATE TRIGGER trg_tenant_phone_dup_alerts_updated_at
  BEFORE UPDATE ON public.tenant_phone_duplicate_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Detector: scans profiles, upserts near-duplicate groups, emits an event for brand-new alerts
CREATE OR REPLACE FUNCTION public.detect_tenant_phone_near_duplicates()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_count integer := 0;
  r record;
BEGIN
  FOR r IN
    WITH norm AS (
      SELECT id, full_name, phone,
             regexp_replace(COALESCE(phone, ''), '\D', '', 'g') AS digits
      FROM public.profiles
      WHERE phone IS NOT NULL
        AND length(regexp_replace(COALESCE(phone, ''), '\D', '', 'g')) >= 9
    ),
    keyed AS (
      SELECT id, full_name, phone,
             right(digits, 8) AS last8,
             right(digits, 9) AS last9
      FROM norm
    ),
    grp AS (
      SELECT last8,
             count(DISTINCT last9) AS distinct_numbers,
             count(*)::int AS member_count,
             array_agg(id ORDER BY id) AS ids,
             (array_agg(DISTINCT full_name))[1:5] AS names,
             (array_agg(DISTINCT phone))[1:5] AS phones
      FROM keyed
      GROUP BY last8
      HAVING count(DISTINCT last9) > 1
    ),
    upserted AS (
      INSERT INTO public.tenant_phone_duplicate_alerts AS t
        (signature, match_type, phone_key, member_ids, member_count, sample_names, sample_phones, status)
      SELECT 'near8:' || last8, 'near_phone_last8', last8, ids, member_count, names, phones, 'open'
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
        'sample_names', to_jsonb(r.sample_names)
      )
    );
  END LOOP;

  RETURN v_new_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.detect_tenant_phone_near_duplicates() TO authenticated, service_role;