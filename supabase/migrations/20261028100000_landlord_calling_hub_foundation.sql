-- =============================================================================
-- Migration: 20261028100000_landlord_calling_hub_foundation.sql
-- Purpose:   Data layer for the new Landlord Calling Hub (`/landlord-ops/calling`).
--            Additive only: three new tables (`landlord_calls`,
--            `landlord_call_dials`, `landlord_call_amendments`), one effective
--            read view (`v_landlord_calls_effective`), and six RPCs
--            (`landlord_hub_list`, `landlord_hub_detail`, `landlord_hub_start_dial`,
--            `landlord_hub_record_call`, `landlord_hub_amend_call`,
--            `landlord_hub_stats`).
--            Leaves Tenant Ops, the shared Calling Hub (`cc_*`), the Landlord
--            Calling Center, `rent_pipeline_awareness_calls`,
--            `landlord_call_reports`, `cc_weekly_all_calls_report`, and Zoe
--            completely untouched. No money movement.
-- Rollback:  supabase/rollbacks/20261028100000_landlord_calling_hub_foundation.rollback.sql
-- Test:      supabase/tests/landlord_calling_hub.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Role-gate helpers (owner-only; called inside each SECURITY DEFINER RPC)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._landlord_hub_can_read()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.has_role(auth.uid(), 'landlord_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );
$$;

REVOKE ALL ON FUNCTION public._landlord_hub_can_read() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._landlord_hub_can_record()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.has_role(auth.uid(), 'landlord_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
  );
$$;

REVOKE ALL ON FUNCTION public._landlord_hub_can_record() FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Table: public.landlord_calls (append-only call log)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.landlord_calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_key      text NOT NULL
    CONSTRAINT landlord_calls_landlord_key_check CHECK (length(btrim(landlord_key)) > 0),
  landlord_id       uuid NULL,
  landlord_name     text NULL,
  phone_dialed      text NOT NULL
    CONSTRAINT landlord_calls_phone_check CHECK (length(btrim(phone_dialed)) >= 7),
  caller_id         uuid NOT NULL,
  caller_team       text NULL
    CONSTRAINT landlord_calls_caller_team_check CHECK (
      caller_team IS NULL OR caller_team IN ('service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'operations', 'other')
    ),
  dial_started_at   timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  result            text NOT NULL
    CONSTRAINT landlord_calls_result_check CHECK (
      result IN ('answered', 'no_answer', 'phone_off', 'wrong_number', 'call_back')
    ),
  call_back_at      timestamptz NULL,
  aware_30m         text NULL
    CONSTRAINT landlord_calls_aware_30m_check CHECK (
      aware_30m IS NULL OR aware_30m IN ('knew', 'heard', 'did_not_know')
    ),
  landlord_consent  text NULL
    CONSTRAINT landlord_calls_landlord_consent_check CHECK (
      landlord_consent IS NULL OR landlord_consent IN ('consents', 'unsure', 'refuses')
    ),
  aware_payout_otp  text NULL
    CONSTRAINT landlord_calls_aware_payout_otp_check CHECK (
      aware_payout_otp IS NULL OR aware_payout_otp IN ('knew', 'heard', 'did_not_know')
    ),
  explained         text NULL
    CONSTRAINT landlord_calls_explained_check CHECK (
      explained IS NULL OR explained IN ('yes', 'partly', 'no')
    ),
  feedback_category text NULL
    CONSTRAINT landlord_calls_feedback_category_check CHECK (
      feedback_category IS NULL OR feedback_category IN (
        'reached_ok',
        'confirmed_payout_number',
        'wants_more_tenants',
        'complaint',
        'payout_issue',
        'not_landlord',
        'wrong_number'
      )
    ),
  severity          text NULL
    CONSTRAINT landlord_calls_severity_check CHECK (
      severity IS NULL OR severity IN ('normal', 'high', 'critical')
    ),
  note              text NULL
    CONSTRAINT landlord_calls_note_length_check CHECK (
      note IS NULL OR length(note) <= 2000
    ),
  tenants_discussed uuid[] NULL,
  voided_at         timestamptz NULL,
  void_reason       text NULL,
  CONSTRAINT landlord_calls_unique_dial UNIQUE (caller_id, landlord_key, dial_started_at),
  CONSTRAINT landlord_calls_answers_and_feedback_check CHECK (
    (
      result = 'answered'
      AND aware_30m IS NOT NULL
      AND landlord_consent IS NOT NULL
      AND aware_payout_otp IS NOT NULL
      AND explained IS NOT NULL
      AND feedback_category IS NOT NULL
      AND severity IS NOT NULL
      AND note IS NOT NULL
      AND length(btrim(note)) >= 20
    )
    OR (
      result <> 'answered'
      AND aware_30m IS NULL
      AND landlord_consent IS NULL
      AND aware_payout_otp IS NULL
      AND explained IS NULL
      AND feedback_category IS NULL
      AND severity IS NULL
    )
  ),
  CONSTRAINT landlord_calls_callback_check CHECK (
    (result = 'call_back' AND call_back_at IS NOT NULL AND call_back_at > recorded_at)
    OR (result <> 'call_back')
  )
);

CREATE INDEX IF NOT EXISTS landlord_calls_landlord_key_recorded_idx
  ON public.landlord_calls (landlord_key, recorded_at DESC);
CREATE INDEX IF NOT EXISTS landlord_calls_landlord_id_recorded_idx
  ON public.landlord_calls (landlord_id, recorded_at DESC)
  WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS landlord_calls_caller_recorded_idx
  ON public.landlord_calls (caller_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS landlord_calls_recorded_at_idx
  ON public.landlord_calls (recorded_at DESC);
CREATE INDEX IF NOT EXISTS landlord_calls_callback_at_idx
  ON public.landlord_calls (call_back_at ASC)
  WHERE call_back_at IS NOT NULL AND voided_at IS NULL;

-- Append-only trigger on landlord_calls (blocks UPDATE and DELETE for all roles, including table owner)
CREATE OR REPLACE FUNCTION public.landlord_calls_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  RAISE EXCEPTION 'landlord_calls is append-only: % is not allowed', TG_OP
    USING ERRCODE = '42501';
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_calls_append_only() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS landlord_calls_no_change ON public.landlord_calls;
CREATE TRIGGER landlord_calls_no_change
  BEFORE UPDATE OR DELETE ON public.landlord_calls
  FOR EACH ROW EXECUTE FUNCTION public.landlord_calls_append_only();

REVOKE ALL ON TABLE public.landlord_calls FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.landlord_calls TO authenticated;
GRANT SELECT, INSERT ON TABLE public.landlord_calls TO service_role;

ALTER TABLE public.landlord_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.landlord_calls;
CREATE POLICY mfa_required_for_staff ON public.landlord_calls
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS landlord_calls_select ON public.landlord_calls;
CREATE POLICY landlord_calls_select ON public.landlord_calls
  FOR SELECT
  TO authenticated
  USING (public._landlord_hub_can_read());

-- -----------------------------------------------------------------------------
-- 3. Table: public.landlord_call_dials (short-lived dial markers)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.landlord_call_dials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_key text NOT NULL
    CONSTRAINT landlord_call_dials_landlord_key_check CHECK (length(btrim(landlord_key)) > 0),
  caller_id    uuid NOT NULL,
  phone        text NOT NULL
    CONSTRAINT landlord_call_dials_phone_check CHECK (length(btrim(phone)) >= 7),
  started_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '20 minutes'),
  call_id      uuid NULL REFERENCES public.landlord_calls (id),
  CONSTRAINT landlord_call_dials_expiry_check CHECK (expires_at > started_at)
);

CREATE INDEX IF NOT EXISTS landlord_call_dials_active_landlord_idx
  ON public.landlord_call_dials (landlord_key, expires_at DESC)
  WHERE call_id IS NULL;
CREATE INDEX IF NOT EXISTS landlord_call_dials_caller_started_idx
  ON public.landlord_call_dials (caller_id, started_at DESC);

REVOKE ALL ON TABLE public.landlord_call_dials FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.landlord_call_dials TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.landlord_call_dials TO service_role;

ALTER TABLE public.landlord_call_dials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.landlord_call_dials;
CREATE POLICY mfa_required_for_staff ON public.landlord_call_dials
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS landlord_call_dials_select ON public.landlord_call_dials;
CREATE POLICY landlord_call_dials_select ON public.landlord_call_dials
  FOR SELECT
  TO authenticated
  USING (public._landlord_hub_can_read());

-- -----------------------------------------------------------------------------
-- 4. Table: public.landlord_call_amendments (append-only 24h correction trail)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.landlord_call_amendments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id    uuid NOT NULL REFERENCES public.landlord_calls (id),
  edited_by  uuid NOT NULL,
  edited_at  timestamptz NOT NULL DEFAULT now(),
  reason     text NOT NULL
    CONSTRAINT landlord_call_amendments_reason_check CHECK (
      length(btrim(reason)) >= 5 AND length(reason) <= 1000
    ),
  old_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_values jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS landlord_call_amendments_call_edited_idx
  ON public.landlord_call_amendments (call_id, edited_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.landlord_call_amendments_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  RAISE EXCEPTION 'landlord_call_amendments is append-only: % is not allowed', TG_OP
    USING ERRCODE = '42501';
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_call_amendments_append_only() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS landlord_call_amendments_no_change ON public.landlord_call_amendments;
CREATE TRIGGER landlord_call_amendments_no_change
  BEFORE UPDATE OR DELETE ON public.landlord_call_amendments
  FOR EACH ROW EXECUTE FUNCTION public.landlord_call_amendments_append_only();

REVOKE ALL ON TABLE public.landlord_call_amendments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.landlord_call_amendments TO authenticated;
GRANT SELECT, INSERT ON TABLE public.landlord_call_amendments TO service_role;

ALTER TABLE public.landlord_call_amendments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.landlord_call_amendments;
CREATE POLICY mfa_required_for_staff ON public.landlord_call_amendments
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS landlord_call_amendments_select ON public.landlord_call_amendments;
CREATE POLICY landlord_call_amendments_select ON public.landlord_call_amendments
  FOR SELECT
  TO authenticated
  USING (public._landlord_hub_can_read());

-- -----------------------------------------------------------------------------
-- 5. Effective View: public.v_landlord_calls_effective
--    Merges the latest amendment onto each landlord_calls row without ever
--    updating the underlying append-only row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_landlord_calls_effective
WITH (security_invoker = true)
AS
SELECT
  c.id,
  c.landlord_key,
  c.landlord_id,
  c.landlord_name,
  c.phone_dialed,
  c.caller_id,
  c.caller_team,
  c.dial_started_at,
  c.recorded_at,
  COALESCE(am.new_values->>'result', c.result) AS result,
  CASE
    WHEN am.new_values IS NOT NULL AND am.new_values ? 'call_back_at' THEN
      NULLIF(am.new_values->>'call_back_at', '')::timestamptz
    ELSE c.call_back_at
  END AS call_back_at,
  CASE
    WHEN COALESCE(am.new_values->>'result', c.result) = 'answered' THEN
      COALESCE(
        CASE WHEN am.new_values ? 'aware_30m' THEN NULLIF(am.new_values->>'aware_30m', '') END,
        c.aware_30m
      )
    ELSE NULL
  END AS aware_30m,
  CASE
    WHEN COALESCE(am.new_values->>'result', c.result) = 'answered' THEN
      COALESCE(
        CASE WHEN am.new_values ? 'landlord_consent' THEN NULLIF(am.new_values->>'landlord_consent', '') END,
        c.landlord_consent
      )
    ELSE NULL
  END AS landlord_consent,
  CASE
    WHEN COALESCE(am.new_values->>'result', c.result) = 'answered' THEN
      COALESCE(
        CASE WHEN am.new_values ? 'aware_payout_otp' THEN NULLIF(am.new_values->>'aware_payout_otp', '') END,
        c.aware_payout_otp
      )
    ELSE NULL
  END AS aware_payout_otp,
  CASE
    WHEN COALESCE(am.new_values->>'result', c.result) = 'answered' THEN
      COALESCE(
        CASE WHEN am.new_values ? 'explained' THEN NULLIF(am.new_values->>'explained', '') END,
        c.explained
      )
    ELSE NULL
  END AS explained,
  CASE
    WHEN COALESCE(am.new_values->>'result', c.result) = 'answered' THEN
      COALESCE(
        CASE WHEN am.new_values ? 'feedback_category' THEN NULLIF(am.new_values->>'feedback_category', '') END,
        c.feedback_category
      )
    ELSE NULL
  END AS feedback_category,
  CASE
    WHEN COALESCE(am.new_values->>'result', c.result) = 'answered' THEN
      COALESCE(
        CASE WHEN am.new_values ? 'severity' THEN NULLIF(am.new_values->>'severity', '') END,
        c.severity
      )
    ELSE NULL
  END AS severity,
  CASE
    WHEN am.new_values IS NOT NULL AND am.new_values ? 'note' THEN
      NULLIF(am.new_values->>'note', '')
    ELSE c.note
  END AS note,
  CASE
    WHEN am.new_values IS NOT NULL AND am.new_values ? 'tenants_discussed'
         AND jsonb_typeof(am.new_values->'tenants_discussed') = 'array' THEN
      ARRAY(SELECT (jsonb_array_elements_text(am.new_values->'tenants_discussed'))::uuid)
    ELSE c.tenants_discussed
  END AS tenants_discussed,
  CASE
    WHEN am.new_values IS NOT NULL AND am.new_values ? 'voided_at' THEN
      NULLIF(am.new_values->>'voided_at', '')::timestamptz
    ELSE c.voided_at
  END AS voided_at,
  CASE
    WHEN am.new_values IS NOT NULL AND am.new_values ? 'void_reason' THEN
      NULLIF(am.new_values->>'void_reason', '')
    ELSE c.void_reason
  END AS void_reason,
  (am.id IS NOT NULL) AS is_amended,
  am.id AS latest_amendment_id,
  am.edited_by AS amended_by,
  am.edited_at AS amended_at,
  am.reason AS amendment_reason
FROM public.landlord_calls c
LEFT JOIN LATERAL (
  SELECT a.id, a.edited_by, a.edited_at, a.reason, a.new_values
  FROM public.landlord_call_amendments a
  WHERE a.call_id = c.id
  ORDER BY a.edited_at DESC, a.id DESC
  LIMIT 1
) am ON true;

REVOKE ALL ON public.v_landlord_calls_effective FROM PUBLIC, anon;
GRANT SELECT ON public.v_landlord_calls_effective TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5b. Materialized Registry Snapshot: public.mv_landlord_hub_registry
--     Materializes public.v_landlord_registry_all (106k+ rows with regex phone
--     normalization and window partitioning) so landlord_hub_list,
--     landlord_hub_detail, and landlord_hub_stats execute in < 100ms while
--     joining live against landlord_calls, landlord_call_dials, and
--     v_landlord_calls_effective. Refreshed every 5 minutes via pg_cron.
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_landlord_hub_registry AS
SELECT
  reg.landlord_key::text AS landlord_key_text,
  reg.*
FROM public.v_landlord_registry_all reg;

CREATE UNIQUE INDEX IF NOT EXISTS mv_landlord_hub_registry_key_text_idx
  ON public.mv_landlord_hub_registry (landlord_key_text);
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_landlord_id_idx
  ON public.mv_landlord_hub_registry (landlord_id)
  WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_live_plans_sort_idx
  ON public.mv_landlord_hub_registry (plan_rent_total DESC NULLS LAST, active_rent_plans DESC NULLS LAST, landlord_key_text ASC)
  WHERE active_rent_plans > 0;
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_all_sort_idx
  ON public.mv_landlord_hub_registry (plan_rent_total DESC NULLS LAST, active_rent_plans DESC NULLS LAST, landlord_key_text ASC);
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_region_district_idx
  ON public.mv_landlord_hub_registry (lower(region), lower(district));

REVOKE ALL ON TABLE public.mv_landlord_hub_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.mv_landlord_hub_registry TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_mv_landlord_hub_registry()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_landlord_hub_registry;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_mv_landlord_hub_registry() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_mv_landlord_hub_registry() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.schedule(
      'refresh-landlord-hub-registry-5m',
      '*/5 * * * *',
      $cron$SELECT public.refresh_mv_landlord_hub_registry();$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

-- -----------------------------------------------------------------------------
-- 6. Function: public.landlord_hub_start_dial(p_landlord_key, p_phone)
--    Creates a 20-minute dial marker. Refuses with a clear message if another
--    officer dialled this landlord in the last 20 minutes and has not recorded.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_hub_start_dial(
  p_landlord_key text,
  p_phone        text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor      uuid := auth.uid();
  v_key        text := btrim(COALESCE(p_landlord_key, ''));
  v_phone      text := btrim(COALESCE(p_phone, ''));
  v_active     record;
  v_own        public.landlord_call_dials%ROWTYPE;
  v_dial       public.landlord_call_dials%ROWTYPE;
  v_caller_nm  text;
BEGIN
  IF NOT public._landlord_hub_can_record() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Landlord Ops and Operations officers can start a landlord call'
      USING ERRCODE = '42501';
  END IF;

  IF v_key = '' THEN
    RAISE EXCEPTION 'LANDLORD_REQUIRED: p_landlord_key is required'
      USING ERRCODE = '22023';
  END IF;

  IF length(regexp_replace(v_phone, '\D', '', 'g')) < 7 THEN
    RAISE EXCEPTION 'PHONE_INVALID: a valid phone number (at least 7 digits) is required'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent dials on the same landlord key within this transaction
  PERFORM pg_advisory_xact_lock(hashtext('landlord_hub_dial:' || v_key));

  -- Check if ANOTHER officer has an active unrecorded dial for this landlord in the last 20 minutes
  SELECT
    d.id,
    d.caller_id,
    d.started_at,
    d.expires_at,
    COALESCE(NULLIF(btrim(p.full_name), ''), 'Another officer') AS caller_name
  INTO v_active
  FROM public.landlord_call_dials d
  LEFT JOIN public.profiles p ON p.id = d.caller_id
  WHERE d.landlord_key = v_key
    AND d.call_id IS NULL
    AND d.expires_at > now()
    AND d.caller_id <> v_actor
  ORDER BY d.started_at DESC
  LIMIT 1;

  IF v_active.id IS NOT NULL THEN
    RAISE EXCEPTION 'DIAL_IN_PROGRESS: Being called by % since % (active until %)',
      v_active.caller_name,
      to_char(v_active.started_at AT TIME ZONE 'Africa/Kampala', 'HH24:MI'),
      to_char(v_active.expires_at AT TIME ZONE 'Africa/Kampala', 'HH24:MI')
      USING ERRCODE = '23505';
  END IF;

  -- If the same officer already has an active unrecorded dial for the same landlord and phone, return it idempotently
  SELECT * INTO v_own
  FROM public.landlord_call_dials d
  WHERE d.landlord_key = v_key
    AND d.caller_id = v_actor
    AND d.phone = v_phone
    AND d.call_id IS NULL
    AND d.expires_at > now()
  ORDER BY d.started_at DESC
  LIMIT 1;

  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), 'Landlord Ops officer')
    INTO v_caller_nm
  FROM public.profiles p
  WHERE p.id = v_actor;

  IF v_own.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'dial_id', v_own.id,
      'landlord_key', v_own.landlord_key,
      'caller_id', v_own.caller_id,
      'caller_name', v_caller_nm,
      'phone', v_own.phone,
      'started_at', v_own.started_at,
      'expires_at', v_own.expires_at,
      'reused', true
    );
  END IF;

  INSERT INTO public.landlord_call_dials (
    landlord_key, caller_id, phone, started_at, expires_at
  ) VALUES (
    v_key, v_actor, v_phone, now(), now() + interval '20 minutes'
  )
  RETURNING * INTO v_dial;

  RETURN jsonb_build_object(
    'dial_id', v_dial.id,
    'landlord_key', v_dial.landlord_key,
    'caller_id', v_dial.caller_id,
    'caller_name', v_caller_nm,
    'phone', v_dial.phone,
    'started_at', v_dial.started_at,
    'expires_at', v_dial.expires_at,
    'reused', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_hub_start_dial(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_hub_start_dial(text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. Function: public.landlord_hub_record_call(...)
--    Records a call from a dial marker (or direct dial timestamp), validating
--    every constraint, linking the dial marker, and emitting a system_events row.
--    Idempotent on (caller_id, landlord_key, dial_started_at).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_hub_record_call(
  p_landlord_key      text,
  p_phone_dialed      text,
  p_dial_started_at   timestamptz,
  p_result            text,
  p_dial_id           uuid DEFAULT NULL,
  p_landlord_id       uuid DEFAULT NULL,
  p_landlord_name     text DEFAULT NULL,
  p_call_back_at      timestamptz DEFAULT NULL,
  p_aware_30m         text DEFAULT NULL,
  p_landlord_consent  text DEFAULT NULL,
  p_aware_payout_otp  text DEFAULT NULL,
  p_explained         text DEFAULT NULL,
  p_feedback_category text DEFAULT NULL,
  p_severity          text DEFAULT NULL,
  p_note              text DEFAULT NULL,
  p_tenants_discussed uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor         uuid := auth.uid();
  v_key           text := btrim(COALESCE(p_landlord_key, ''));
  v_phone         text := btrim(COALESCE(p_phone_dialed, ''));
  v_dial_start    timestamptz := p_dial_started_at;
  v_dial_row      public.landlord_call_dials%ROWTYPE;
  v_existing      public.landlord_calls%ROWTYPE;
  v_row           public.landlord_calls%ROWTYPE;
  v_team          text;
  v_note          text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_ll_id         uuid := p_landlord_id;
  v_ll_name       text := NULLIF(btrim(COALESCE(p_landlord_name, '')), '');
  v_entity_uuid   uuid;
BEGIN
  IF NOT public._landlord_hub_can_record() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Landlord Ops and Operations officers can record a landlord call'
      USING ERRCODE = '42501';
  END IF;

  -- If a dial marker id was provided, load and validate ownership
  IF p_dial_id IS NOT NULL THEN
    SELECT * INTO v_dial_row
    FROM public.landlord_call_dials d
    WHERE d.id = p_dial_id;

    IF v_dial_row.id IS NULL THEN
      RAISE EXCEPTION 'DIAL_NOT_FOUND: dial marker not found'
        USING ERRCODE = '22023';
    END IF;
    IF v_dial_row.caller_id <> v_actor THEN
      RAISE EXCEPTION 'NOT_AUTHORISED: cannot record a call against another officer''s dial marker'
        USING ERRCODE = '42501';
    END IF;

    IF v_key = '' THEN
      v_key := v_dial_row.landlord_key;
    END IF;
    IF v_phone = '' THEN
      v_phone := v_dial_row.phone;
    END IF;
    IF v_dial_start IS NULL THEN
      v_dial_start := v_dial_row.started_at;
    END IF;
  END IF;

  IF v_key = '' THEN
    RAISE EXCEPTION 'LANDLORD_REQUIRED: p_landlord_key is required'
      USING ERRCODE = '22023';
  END IF;

  IF length(regexp_replace(v_phone, '\D', '', 'g')) < 7 THEN
    RAISE EXCEPTION 'PHONE_INVALID: the phone number that was dialled is required'
      USING ERRCODE = '22023';
  END IF;

  IF v_dial_start IS NULL THEN
    RAISE EXCEPTION 'DIAL_START_REQUIRED: p_dial_started_at is required'
      USING ERRCODE = '22023';
  END IF;

  IF v_dial_start > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'DIAL_START_FUTURE: the call cannot start in the future'
      USING ERRCODE = '22023';
  END IF;

  IF p_result IS NULL OR p_result NOT IN ('answered', 'no_answer', 'phone_off', 'wrong_number', 'call_back') THEN
    RAISE EXCEPTION 'RESULT_INVALID: result must be answered, no_answer, phone_off, wrong_number or call_back'
      USING ERRCODE = '22023';
  END IF;

  -- Validate answered vs unanswered vs call_back exactly as table constraints require
  IF p_result = 'answered' THEN
    IF p_aware_30m IS NULL OR p_landlord_consent IS NULL OR p_aware_payout_otp IS NULL OR p_explained IS NULL THEN
      RAISE EXCEPTION 'ANSWERS_REQUIRED: an answered call requires all four awareness answers (aware_30m, landlord_consent, aware_payout_otp, explained)'
        USING ERRCODE = '22023';
    END IF;
    IF p_aware_30m NOT IN ('knew', 'heard', 'did_not_know') OR p_aware_payout_otp NOT IN ('knew', 'heard', 'did_not_know') THEN
      RAISE EXCEPTION 'ANSWERS_INVALID: aware_30m and aware_payout_otp must be knew, heard or did_not_know'
        USING ERRCODE = '22023';
    END IF;
    IF p_landlord_consent NOT IN ('consents', 'unsure', 'refuses') THEN
      RAISE EXCEPTION 'CONSENT_INVALID: landlord_consent must be consents, unsure or refuses'
        USING ERRCODE = '22023';
    END IF;
    IF p_explained NOT IN ('yes', 'partly', 'no') THEN
      RAISE EXCEPTION 'EXPLAINED_INVALID: explained must be yes, partly or no'
        USING ERRCODE = '22023';
    END IF;
    IF p_feedback_category IS NULL OR p_feedback_category NOT IN (
      'reached_ok', 'confirmed_payout_number', 'wants_more_tenants',
      'complaint', 'payout_issue', 'not_landlord', 'wrong_number'
    ) THEN
      RAISE EXCEPTION 'CATEGORY_INVALID: an answered call requires a valid feedback_category'
        USING ERRCODE = '22023';
    END IF;
    IF p_severity IS NULL OR p_severity NOT IN ('normal', 'high', 'critical') THEN
      RAISE EXCEPTION 'SEVERITY_INVALID: an answered call requires severity (normal, high or critical)'
        USING ERRCODE = '22023';
    END IF;
    IF v_note IS NULL OR length(v_note) < 20 THEN
      RAISE EXCEPTION 'NOTE_TOO_SHORT: an answered call requires a note of at least 20 characters'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_aware_30m IS NOT NULL OR p_landlord_consent IS NOT NULL OR p_aware_payout_otp IS NOT NULL
       OR p_explained IS NOT NULL OR p_feedback_category IS NOT NULL OR p_severity IS NOT NULL THEN
      RAISE EXCEPTION 'UNANSWERED_FIELDS_NOT_ALLOWED: awareness answers, feedback_category and severity must be null when result is not answered'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_result = 'call_back' THEN
    IF p_call_back_at IS NULL OR p_call_back_at <= now() THEN
      RAISE EXCEPTION 'CALLBACK_TIME_INVALID: call_back requires a future call_back_at timestamp'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN
    RAISE EXCEPTION 'NOTE_TOO_LONG: note must be 2000 characters or fewer'
      USING ERRCODE = '22023';
  END IF;

  -- Idempotent retry check on (caller_id, landlord_key, dial_started_at)
  SELECT * INTO v_existing
  FROM public.landlord_calls c
  WHERE c.caller_id = v_actor
    AND c.landlord_key = v_key
    AND c.dial_started_at = v_dial_start;

  IF v_existing.id IS NOT NULL THEN
    -- Ensure any matching dial marker is linked
    UPDATE public.landlord_call_dials d
       SET call_id = v_existing.id
     WHERE d.caller_id = v_actor
       AND d.landlord_key = v_key
       AND d.call_id IS NULL
       AND (p_dial_id IS NULL OR d.id = p_dial_id);

    RETURN to_jsonb(v_existing) || jsonb_build_object('already_recorded', true);
  END IF;

  -- Enrich landlord_id / landlord_name from landlords table when landlord_key is a uuid and fields were omitted
  BEGIN
    v_entity_uuid := v_key::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_entity_uuid := NULL;
  END;

  IF v_entity_uuid IS NOT NULL AND (v_ll_id IS NULL OR v_ll_name IS NULL) THEN
    SELECT
      COALESCE(v_ll_id, l.id),
      COALESCE(v_ll_name, NULLIF(btrim(l.name), ''))
    INTO v_ll_id, v_ll_name
    FROM public.landlords l
    WHERE l.id = v_entity_uuid;

    IF v_ll_name IS NULL THEN
      SELECT NULLIF(btrim(p.full_name), '')
        INTO v_ll_name
      FROM public.profiles p
      WHERE p.id = v_entity_uuid;
    END IF;
  END IF;

  v_team := CASE
    WHEN public.has_role(v_actor, 'landlord_ops'::app_role) THEN 'landlord_ops'
    WHEN public.has_role(v_actor, 'operations'::app_role) THEN 'operations'
    ELSE 'other'
  END;

  INSERT INTO public.landlord_calls (
    landlord_key,
    landlord_id,
    landlord_name,
    phone_dialed,
    caller_id,
    caller_team,
    dial_started_at,
    recorded_at,
    result,
    call_back_at,
    aware_30m,
    landlord_consent,
    aware_payout_otp,
    explained,
    feedback_category,
    severity,
    note,
    tenants_discussed
  ) VALUES (
    v_key,
    v_ll_id,
    v_ll_name,
    v_phone,
    v_actor,
    v_team,
    v_dial_start,
    now(),
    p_result,
    p_call_back_at,
    p_aware_30m,
    p_landlord_consent,
    p_aware_payout_otp,
    p_explained,
    p_feedback_category,
    p_severity,
    v_note,
    p_tenants_discussed
  )
  RETURNING * INTO v_row;

  -- Link the dial marker (by p_dial_id or the latest active unrecorded dial for this caller + landlord)
  IF p_dial_id IS NOT NULL THEN
    UPDATE public.landlord_call_dials
       SET call_id = v_row.id
     WHERE id = p_dial_id
       AND caller_id = v_actor;
  ELSE
    UPDATE public.landlord_call_dials
       SET call_id = v_row.id
     WHERE id = (
       SELECT d.id
       FROM public.landlord_call_dials d
       WHERE d.caller_id = v_actor
         AND d.landlord_key = v_key
         AND d.call_id IS NULL
       ORDER BY d.started_at DESC
       LIMIT 1
     );
  END IF;

  INSERT INTO public.system_events (
    event_type,
    user_id,
    related_entity_type,
    related_entity_id,
    metadata
  ) VALUES (
    'landlord_hub.call_recorded',
    v_actor,
    'landlord',
    COALESCE(v_ll_id, v_entity_uuid),
    jsonb_build_object(
      'call_id', v_row.id,
      'landlord_key', v_key,
      'landlord_id', v_ll_id,
      'result', p_result,
      'call_back_at', p_call_back_at,
      'caller_team', v_team,
      'aware_30m', p_aware_30m,
      'landlord_consent', p_landlord_consent,
      'aware_payout_otp', p_aware_payout_otp,
      'explained', p_explained,
      'feedback_category', p_feedback_category,
      'severity', p_severity,
      'source', 'landlord_calling_hub'
    )
  );

  RETURN to_jsonb(v_row) || jsonb_build_object('already_recorded', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_hub_record_call(text, text, timestamptz, text, uuid, uuid, text, timestamptz, text, text, text, text, text, text, text, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_hub_record_call(text, text, timestamptz, text, uuid, uuid, text, timestamptz, text, text, text, text, text, text, text, uuid[]) TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Function: public.landlord_hub_amend_call(p_call_id, p_changes, p_reason)
--    Allowed only to the same caller within 24 hours (except call_back_at
--    take-over by any landlord_ops/operations officer); writes an amendment row;
--    never updates or deletes the original landlord_calls row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_hub_amend_call(
  p_call_id uuid,
  p_changes jsonb,
  p_reason  text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor        uuid := auth.uid();
  v_orig         public.landlord_calls%ROWTYPE;
  v_curr         public.v_landlord_calls_effective%ROWTYPE;
  v_reason       text := btrim(COALESCE(p_reason, ''));
  v_merged       jsonb;
  v_old_vals     jsonb;
  v_res          text;
  v_cb_at        timestamptz;
  v_a30          text;
  v_consent      text;
  v_otp          text;
  v_expl         text;
  v_cat          text;
  v_sev          text;
  v_note         text;
  v_voided_at    timestamptz;
  v_void_reason  text;
  v_amend        public.landlord_call_amendments%ROWTYPE;
BEGIN
  IF NOT public._landlord_hub_can_record() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Landlord Ops and Operations officers can amend a landlord call'
      USING ERRCODE = '42501';
  END IF;

  IF p_call_id IS NULL THEN
    RAISE EXCEPTION 'CALL_REQUIRED: p_call_id is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::jsonb THEN
    RAISE EXCEPTION 'CHANGES_REQUIRED: p_changes must be a non-empty JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF length(v_reason) < 5 OR length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a correction reason of at least 5 characters is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_orig
  FROM public.landlord_calls c
  WHERE c.id = p_call_id;

  IF v_orig.id IS NULL THEN
    RAISE EXCEPTION 'CALL_NOT_FOUND: landlord call not found'
      USING ERRCODE = '22023';
  END IF;

  IF v_orig.caller_id <> v_actor THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only the officer who recorded this call can amend it'
      USING ERRCODE = '42501';
  END IF;

  IF v_orig.recorded_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'AMEND_WINDOW_EXPIRED: a call can only be amended within 24 hours of recording'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_curr
  FROM public.v_landlord_calls_effective e
  WHERE e.id = p_call_id;

  v_old_vals := jsonb_build_object(
    'result', v_curr.result,
    'call_back_at', v_curr.call_back_at,
    'aware_30m', v_curr.aware_30m,
    'landlord_consent', v_curr.landlord_consent,
    'aware_payout_otp', v_curr.aware_payout_otp,
    'explained', v_curr.explained,
    'feedback_category', v_curr.feedback_category,
    'severity', v_curr.severity,
    'note', v_curr.note,
    'tenants_discussed', to_jsonb(v_curr.tenants_discussed),
    'voided_at', v_curr.voided_at,
    'void_reason', v_curr.void_reason
  );

  v_merged := v_old_vals || p_changes;

  v_res := v_merged->>'result';
  v_cb_at := NULLIF(v_merged->>'call_back_at', '')::timestamptz;
  v_a30 := NULLIF(v_merged->>'aware_30m', '');
  v_consent := NULLIF(v_merged->>'landlord_consent', '');
  v_otp := NULLIF(v_merged->>'aware_payout_otp', '');
  v_expl := NULLIF(v_merged->>'explained', '');
  v_cat := NULLIF(v_merged->>'feedback_category', '');
  v_sev := NULLIF(v_merged->>'severity', '');
  v_note := NULLIF(btrim(COALESCE(v_merged->>'note', '')), '');
  v_voided_at := NULLIF(v_merged->>'voided_at', '')::timestamptz;
  v_void_reason := NULLIF(btrim(COALESCE(v_merged->>'void_reason', '')), '');

  -- If result changed away from 'answered' and caller did not explicitly pass null for answered-only fields, clear them in v_merged
  IF v_res IS DISTINCT FROM 'answered' AND NOT (p_changes ? 'aware_30m') THEN
    v_a30 := NULL; v_consent := NULL; v_otp := NULL; v_expl := NULL; v_cat := NULL; v_sev := NULL;
    v_merged := v_merged || jsonb_build_object(
      'aware_30m', null,
      'landlord_consent', null,
      'aware_payout_otp', null,
      'explained', null,
      'feedback_category', null,
      'severity', null
    );
  END IF;

  IF v_res IS NULL OR v_res NOT IN ('answered', 'no_answer', 'phone_off', 'wrong_number', 'call_back') THEN
    RAISE EXCEPTION 'RESULT_INVALID: result must be answered, no_answer, phone_off, wrong_number or call_back'
      USING ERRCODE = '22023';
  END IF;

  IF v_res = 'answered' THEN
    IF v_a30 IS NULL OR v_consent IS NULL OR v_otp IS NULL OR v_expl IS NULL THEN
      RAISE EXCEPTION 'ANSWERS_REQUIRED: an answered call requires all four awareness answers'
        USING ERRCODE = '22023';
    END IF;
    IF v_a30 NOT IN ('knew', 'heard', 'did_not_know') OR v_otp NOT IN ('knew', 'heard', 'did_not_know') THEN
      RAISE EXCEPTION 'ANSWERS_INVALID: aware_30m and aware_payout_otp must be knew, heard or did_not_know'
        USING ERRCODE = '22023';
    END IF;
    IF v_consent NOT IN ('consents', 'unsure', 'refuses') THEN
      RAISE EXCEPTION 'CONSENT_INVALID: landlord_consent must be consents, unsure or refuses'
        USING ERRCODE = '22023';
    END IF;
    IF v_expl NOT IN ('yes', 'partly', 'no') THEN
      RAISE EXCEPTION 'EXPLAINED_INVALID: explained must be yes, partly or no'
        USING ERRCODE = '22023';
    END IF;
    IF v_cat IS NULL OR v_cat NOT IN (
      'reached_ok', 'confirmed_payout_number', 'wants_more_tenants',
      'complaint', 'payout_issue', 'not_landlord', 'wrong_number'
    ) THEN
      RAISE EXCEPTION 'CATEGORY_INVALID: an answered call requires a valid feedback_category'
        USING ERRCODE = '22023';
    END IF;
    IF v_sev IS NULL OR v_sev NOT IN ('normal', 'high', 'critical') THEN
      RAISE EXCEPTION 'SEVERITY_INVALID: an answered call requires severity (normal, high or critical)'
        USING ERRCODE = '22023';
    END IF;
    IF v_note IS NULL OR length(v_note) < 20 THEN
      RAISE EXCEPTION 'NOTE_TOO_SHORT: an answered call requires a note of at least 20 characters'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF v_a30 IS NOT NULL OR v_consent IS NOT NULL OR v_otp IS NOT NULL
       OR v_expl IS NOT NULL OR v_cat IS NOT NULL OR v_sev IS NOT NULL THEN
      RAISE EXCEPTION 'UNANSWERED_FIELDS_NOT_ALLOWED: awareness answers, feedback_category and severity must be null when result is not answered'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_res = 'call_back' AND (v_cb_at IS NULL OR v_cb_at <= v_orig.recorded_at) THEN
    RAISE EXCEPTION 'CALLBACK_TIME_INVALID: call_back requires a call_back_at after recorded_at'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.landlord_call_amendments (
    call_id, edited_by, edited_at, reason, old_values, new_values
  ) VALUES (
    p_call_id, v_actor, now(), v_reason, v_old_vals, v_merged
  )
  RETURNING * INTO v_amend;

  RETURN jsonb_build_object(
    'amendment_id', v_amend.id,
    'call_id', v_amend.call_id,
    'edited_by', v_amend.edited_by,
    'edited_at', v_amend.edited_at,
    'reason', v_amend.reason,
    'old_values', v_amend.old_values,
    'new_values', v_amend.new_values
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_hub_amend_call(uuid, jsonb, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_hub_amend_call(uuid, jsonb, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 9. Function: public.landlord_hub_list(...)
--    Reads v_landlord_registry_all plus the latest call per landlord from
--    v_landlord_calls_effective (and existing awareness / verification / CC
--    sources via v_landlord_registry_all as "last contacted" context), plus
--    active dials for "being-called-by".
--    Scopes: live_plans (default), with_plans, all.
--    Tabs:   to_call, call_back, answered, not_answered, all.
--    Max 50 rows per page.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_hub_list(
  p_scope    text DEFAULT 'live_plans',
  p_tab      text DEFAULT 'to_call',
  p_search   text DEFAULT NULL,
  p_region   text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_agent    text DEFAULT NULL,
  p_verified text DEFAULT NULL,
  p_sort     text DEFAULT 'rent_plan_value',
  p_limit    integer DEFAULT 50,
  p_offset   integer DEFAULT 0
)
RETURNS TABLE (
  landlord_key       text,
  landlord_id        uuid,
  user_id            uuid,
  landlord_name      text,
  phone              text,
  phone_masked       boolean,
  region             text,
  district           text,
  agent_id           uuid,
  agent_name         text,
  verified           boolean,
  verification_status text,
  houses_count       integer,
  live_rent_plans    integer,
  rent_plan_value    numeric,
  last_call_at       timestamptz,
  last_result        text,
  last_caller_id     uuid,
  last_caller_name   text,
  call_back_due_at   timestamptz,
  call_back_overdue  boolean,
  being_called_by_id uuid,
  being_called_by    text,
  being_called_since timestamptz,
  hub_status         text,
  needs_review       boolean,
  total_count        bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_scope     text := lower(btrim(COALESCE(NULLIF(p_scope, ''), 'live_plans')));
  v_tab       text := lower(btrim(COALESCE(NULLIF(p_tab, ''), 'to_call')));
  v_search    text := lower(btrim(COALESCE(p_search, '')));
  v_region    text := NULLIF(btrim(COALESCE(p_region, '')), '');
  v_district  text := NULLIF(btrim(COALESCE(p_district, '')), '');
  v_agent     text := NULLIF(btrim(COALESCE(p_agent, '')), '');
  v_verified  text := lower(btrim(COALESCE(p_verified, '')));
  v_sort      text := lower(btrim(COALESCE(NULLIF(p_sort, ''), 'rent_plan_value')));
  v_limit     integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_offset    integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_unmasked  boolean;
  v_now       timestamptz := now();
BEGIN
  IF NOT public._landlord_hub_can_read() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: you are not authorised to view the Landlord Calling Hub'
      USING ERRCODE = '42501';
  END IF;

  IF v_scope NOT IN ('live_plans', 'with_plans', 'all') THEN
    RAISE EXCEPTION 'SCOPE_INVALID: p_scope must be live_plans, with_plans or all'
      USING ERRCODE = '22023';
  END IF;

  IF v_tab NOT IN ('to_call', 'call_back', 'answered', 'not_answered', 'all') THEN
    RAISE EXCEPTION 'TAB_INVALID: p_tab must be to_call, call_back, answered, not_answered or all'
      USING ERRCODE = '22023';
  END IF;

  v_unmasked := public._landlord_cc_can_view_unmasked_phone();

  RETURN QUERY
  WITH hub_latest AS MATERIALIZED (
    SELECT DISTINCT ON (c.landlord_key)
      c.landlord_key,
      c.id AS call_id,
      c.recorded_at,
      c.result,
      c.call_back_at,
      c.caller_id,
      COALESCE(NULLIF(btrim(cp.full_name), ''), 'Landlord Ops officer') AS caller_name
    FROM public.v_landlord_calls_effective c
    LEFT JOIN public.profiles cp ON cp.id = c.caller_id
    WHERE c.voided_at IS NULL
    ORDER BY c.landlord_key, c.recorded_at DESC, c.id DESC
  ),
  active_dials AS MATERIALIZED (
    SELECT DISTINCT ON (d.landlord_key)
      d.landlord_key,
      d.caller_id,
      COALESCE(NULLIF(btrim(dp.full_name), ''), 'Landlord Ops officer') AS caller_name,
      d.started_at
    FROM public.landlord_call_dials d
    LEFT JOIN public.profiles dp ON dp.id = d.caller_id
    WHERE d.call_id IS NULL
      AND d.expires_at > v_now
    ORDER BY d.landlord_key, d.started_at DESC
  ),
  plans_any AS MATERIALIZED (
    SELECT DISTINCT rr.landlord_id
    FROM public.rent_requests rr
    WHERE v_scope = 'with_plans'
      AND rr.landlord_id IS NOT NULL
  ),
  scoped_reg AS (
    SELECT
      reg.landlord_key_text AS l_key,
      reg.landlord_id,
      reg.user_id,
      COALESCE(NULLIF(btrim(reg.full_name), ''), 'Unnamed Landlord') AS landlord_name,
      reg.phones[1] AS primary_phone,
      reg.region,
      reg.district,
      reg.registering_agent_id AS agent_id,
      reg.registering_agent_name AS agent_name,
      (reg.verification_status = 'verified') AS is_verified,
      reg.verification_status,
      COALESCE(reg.houses_count, 0)::integer AS houses_count,
      COALESCE(reg.active_rent_plans, 0)::integer AS live_rent_plans,
      COALESCE(reg.plan_rent_total, 0)::numeric AS rent_plan_value,
      reg.needs_review,
      reg.registered_at,
      -- Combine hub calls with existing registry last_called_at (awareness, verification, CC)
      CASE
        WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
          THEN hl.recorded_at
        ELSE reg.last_called_at
      END AS eff_last_call_at,
      CASE
        WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
          THEN hl.result
        ELSE reg.last_call_outcome
      END AS eff_last_result,
      CASE
        WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
          THEN hl.caller_id
        ELSE NULL::uuid
      END AS eff_last_caller_id,
      CASE
        WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
          THEN hl.caller_name
        ELSE reg.last_caller_name
      END AS eff_last_caller_name,
      CASE
        WHEN hl.result = 'call_back'
             AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
          THEN hl.call_back_at
        ELSE NULL::timestamptz
      END AS eff_call_back_due_at,
      ad.caller_id AS dial_caller_id,
      ad.caller_name AS dial_caller_name,
      ad.started_at AS dial_started_at
    FROM public.mv_landlord_hub_registry reg
    LEFT JOIN hub_latest hl ON hl.landlord_key = reg.landlord_key_text
    LEFT JOIN active_dials ad ON ad.landlord_key = reg.landlord_key_text
    WHERE (
      (v_scope = 'live_plans' AND reg.active_rent_plans > 0)
      OR (v_scope = 'with_plans' AND (
        reg.active_rent_plans > 0
        OR reg.plan_rent_total > 0
        OR (reg.landlord_id IS NOT NULL AND EXISTS (SELECT 1 FROM plans_any pa WHERE pa.landlord_id = reg.landlord_id))
      ))
      OR (v_scope = 'all')
    )
    AND (
      v_region IS NULL
      OR lower(COALESCE(reg.region, '')) = lower(v_region)
    )
    AND (
      v_district IS NULL
      OR lower(COALESCE(reg.district, '')) = lower(v_district)
    )
    AND (
      v_agent IS NULL
      OR reg.registering_agent_id::text = v_agent
      OR lower(COALESCE(reg.registering_agent_name, '')) = lower(v_agent)
    )
    AND (
      v_verified = ''
      OR v_verified = 'all'
      OR (v_verified IN ('true', 'verified', 'yes', '1') AND reg.verification_status = 'verified')
      OR (v_verified IN ('false', 'unverified', 'no', '0') AND reg.verification_status <> 'verified')
    )
    AND (
      v_search = ''
      OR strpos(lower(COALESCE(reg.full_name, '')), v_search) > 0
      OR strpos(lower(COALESCE(reg.phones[1], '')), v_search) > 0
      OR strpos(lower(COALESCE(reg.district, '')), v_search) > 0
      OR strpos(lower(COALESCE(reg.registering_agent_name, '')), v_search) > 0
    )
  ),
  classified AS (
    SELECT
      s.*,
      CASE
        WHEN s.eff_last_result IN ('call_back', 'call_back_later', 'callback_booked') THEN 'call_back'
        WHEN s.eff_last_result IN (
          'answered', 'engaged', 'reached_ok', 'confirmed_payout_number',
          'wants_more_tenants', 'complaint', 'payout_issue', 'picked_up', 'called'
        ) THEN 'answered'
        WHEN s.eff_last_call_at IS NOT NULL THEN 'not_answered'
        ELSE 'never_called'
      END AS status_bucket
    FROM scoped_reg s
  ),
  filtered AS (
    SELECT
      c.*,
      count(*) OVER ()::bigint AS total_n
    FROM classified c
    WHERE (
      v_tab = 'all'
      OR (v_tab = 'call_back' AND c.status_bucket = 'call_back')
      OR (v_tab = 'answered' AND c.status_bucket = 'answered')
      OR (v_tab = 'not_answered' AND c.status_bucket = 'not_answered')
      OR (
        v_tab = 'to_call'
        AND (
          c.status_bucket = 'never_called'
          OR (c.status_bucket = 'not_answered' AND c.eff_last_call_at < (v_now - interval '7 days'))
        )
      )
    )
  )
  SELECT
    f.l_key AS landlord_key,
    f.landlord_id,
    f.user_id,
    f.landlord_name,
    CASE
      WHEN f.primary_phone IS NULL OR btrim(f.primary_phone) = '' THEN '—'
      WHEN v_unmasked THEN f.primary_phone
      ELSE public.crm_mask_phone(f.primary_phone)
    END AS phone,
    (NOT v_unmasked) AS phone_masked,
    f.region,
    f.district,
    f.agent_id,
    f.agent_name,
    f.is_verified AS verified,
    f.verification_status,
    f.houses_count,
    f.live_rent_plans,
    f.rent_plan_value,
    f.eff_last_call_at AS last_call_at,
    f.eff_last_result AS last_result,
    f.eff_last_caller_id AS last_caller_id,
    f.eff_last_caller_name AS last_caller_name,
    f.eff_call_back_due_at AS call_back_due_at,
    (f.eff_call_back_due_at IS NOT NULL AND f.eff_call_back_due_at < v_now) AS call_back_overdue,
    f.dial_caller_id AS being_called_by_id,
    f.dial_caller_name AS being_called_by,
    f.dial_started_at AS being_called_since,
    f.status_bucket AS hub_status,
    f.needs_review,
    f.total_n AS total_count
  FROM filtered f
  ORDER BY
    CASE WHEN v_sort IN ('call_back_due', 'callback_due') THEN f.eff_call_back_due_at END ASC NULLS LAST,
    CASE WHEN v_sort IN ('last_called', 'last_called_at', 'oldest_call_first') THEN f.eff_last_call_at END ASC NULLS FIRST,
    CASE WHEN v_sort IN ('newest_registration', 'registered_at') THEN f.registered_at END DESC NULLS LAST,
    CASE WHEN v_sort IN ('name', 'landlord_name') THEN lower(f.landlord_name) END ASC NULLS LAST,
    f.rent_plan_value DESC NULLS LAST,
    f.live_rent_plans DESC NULLS LAST,
    f.l_key ASC
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_hub_list(text, text, text, text, text, text, text, text, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_hub_list(text, text, text, text, text, text, text, text, integer, integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- 10. Function: public.landlord_hub_detail(p_landlord_key)
--     Returns the full Landlord Card:
--     - landlord details, payout details, caretaker
--     - houses
--     - tenants and Rent Plans (status, rent, repaid, outstanding)
--     - payouts
--     - registering agent
--     - full call history from landlord_calls (effective), awareness calls,
--       and verification calls, newest first.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_hub_detail(
  p_landlord_key text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_key        text := btrim(COALESCE(p_landlord_key, ''));
  v_unmasked   boolean;
  v_reg        record;
  v_ll         record;
  v_ll_id      uuid;
  v_agent      jsonb;
  v_caretaker  jsonb;
  v_payout_det jsonb;
  v_houses     jsonb;
  v_plans      jsonb;
  v_payouts    jsonb;
  v_history    jsonb;
  v_active_d   jsonb;
BEGIN
  IF NOT public._landlord_hub_can_read() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: you are not authorised to view landlord calling details'
      USING ERRCODE = '42501';
  END IF;

  IF v_key = '' THEN
    RAISE EXCEPTION 'LANDLORD_REQUIRED: p_landlord_key is required'
      USING ERRCODE = '22023';
  END IF;

  v_unmasked := public._landlord_cc_can_view_unmasked_phone();

  SELECT *
    INTO v_reg
  FROM public.mv_landlord_hub_registry r
  WHERE r.landlord_key_text = v_key
  LIMIT 1;

  IF v_reg.landlord_key IS NULL THEN
    RAISE EXCEPTION 'LANDLORD_NOT_FOUND: landlord % not found in registry', v_key
      USING ERRCODE = '22023';
  END IF;

  v_ll_id := v_reg.landlord_id;

  IF v_ll_id IS NOT NULL THEN
    SELECT * INTO v_ll
    FROM public.landlords l
    WHERE l.id = v_ll_id;
  END IF;

  -- Registering agent details
  SELECT jsonb_build_object(
    'agent_id', p.id,
    'full_name', p.full_name,
    'phone', CASE
      WHEN p.phone IS NULL OR btrim(p.phone) = '' THEN NULL
      WHEN v_unmasked THEN p.phone
      ELSE public.crm_mask_phone(p.phone)
    END
  )
  INTO v_agent
  FROM public.profiles p
  WHERE p.id = v_reg.registering_agent_id;

  -- Caretaker details (from landlord row or latest house listing with caretaker)
  SELECT jsonb_build_object(
    'name', COALESCE(
      NULLIF(btrim(v_ll.caretaker_name), ''),
      (SELECT NULLIF(btrim(hl.caretaker_name), '') FROM public.house_listings hl WHERE hl.landlord_id = v_ll_id AND NULLIF(btrim(hl.caretaker_name), '') IS NOT NULL ORDER BY hl.created_at DESC LIMIT 1)
    ),
    'phone', CASE
      WHEN COALESCE(
        NULLIF(btrim(v_ll.caretaker_phone), ''),
        (SELECT NULLIF(btrim(hl.caretaker_phone), '') FROM public.house_listings hl WHERE hl.landlord_id = v_ll_id AND NULLIF(btrim(hl.caretaker_phone), '') IS NOT NULL ORDER BY hl.created_at DESC LIMIT 1)
      ) IS NULL THEN NULL
      WHEN v_unmasked THEN COALESCE(
        NULLIF(btrim(v_ll.caretaker_phone), ''),
        (SELECT NULLIF(btrim(hl.caretaker_phone), '') FROM public.house_listings hl WHERE hl.landlord_id = v_ll_id AND NULLIF(btrim(hl.caretaker_phone), '') IS NOT NULL ORDER BY hl.created_at DESC LIMIT 1)
      )
      ELSE public.crm_mask_phone(COALESCE(
        NULLIF(btrim(v_ll.caretaker_phone), ''),
        (SELECT NULLIF(btrim(hl.caretaker_phone), '') FROM public.house_listings hl WHERE hl.landlord_id = v_ll_id AND NULLIF(btrim(hl.caretaker_phone), '') IS NOT NULL ORDER BY hl.created_at DESC LIMIT 1)
      ))
    END
  ) INTO v_caretaker;

  -- Payout details
  v_payout_det := jsonb_build_object(
    'mobile_money_number', CASE
      WHEN COALESCE(v_ll.mobile_money_number, v_ll.phone, v_reg.phones[1]) IS NULL THEN NULL
      WHEN v_unmasked THEN COALESCE(v_ll.mobile_money_number, v_ll.phone, v_reg.phones[1])
      ELSE public.crm_mask_phone(COALESCE(v_ll.mobile_money_number, v_ll.phone, v_reg.phones[1]))
    END,
    'mobile_money_name', v_ll.mobile_money_name,
    'verified_mobile_money_number', CASE
      WHEN v_ll.verified_mobile_money_number IS NULL THEN NULL
      WHEN v_unmasked THEN v_ll.verified_mobile_money_number
      ELSE public.crm_mask_phone(v_ll.verified_mobile_money_number)
    END,
    'bank_name', v_ll.bank_name,
    'bank_branch', v_ll.bank_branch,
    'account_number', CASE
      WHEN v_ll.account_number IS NULL THEN NULL
      WHEN v_unmasked THEN v_ll.account_number
      ELSE public.crm_mask_phone(v_ll.account_number)
    END,
    'bank_account_name', v_ll.bank_account_name,
    'total_paid_out_ugx', COALESCE(v_reg.total_paid_out_ugx, 0),
    'last_payout_at', v_reg.last_payout_at
  );

  -- Houses
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', hl.id,
      'title', COALESCE(NULLIF(btrim(hl.title), ''), NULLIF(btrim(hl.address), ''), 'House Listing'),
      'address', hl.address,
      'region', hl.region,
      'district', hl.district,
      'village', hl.village,
      'house_category', hl.house_category,
      'number_of_rooms', hl.number_of_rooms,
      'monthly_rent', COALESCE(hl.monthly_rent, 0),
      'daily_rate', COALESCE(hl.daily_rate, 0),
      'status', COALESCE(hl.status, 'listed'),
      'verified', COALESCE(hl.verified, false),
      'caretaker_name', hl.caretaker_name,
      'created_at', hl.created_at
    ) ORDER BY hl.created_at DESC
  ), '[]'::jsonb)
  INTO v_houses
  FROM public.house_listings hl
  WHERE v_ll_id IS NOT NULL
    AND hl.landlord_id = v_ll_id
    AND COALESCE(hl.status, '') NOT IN ('rejected', 'delisted');

  -- Tenants and Rent Plans
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'rent_request_id', rr.id,
      'tenant_id', rr.tenant_id,
      'tenant_name', COALESCE(NULLIF(btrim(tp.full_name), ''), 'Unnamed Tenant'),
      'tenant_phone', CASE
        WHEN tp.phone IS NULL OR btrim(tp.phone) = '' THEN NULL
        WHEN v_unmasked THEN tp.phone
        ELSE public.crm_mask_phone(tp.phone)
      END,
      'status', rr.status,
      'rent_amount', COALESCE(rr.rent_amount, 0),
      'daily_repayment', COALESCE(rr.daily_repayment, 0),
      'total_repayment', COALESCE(rr.total_repayment, 0),
      'amount_repaid', COALESCE(rr.amount_repaid, 0),
      'outstanding', CASE
        WHEN rr.status IN ('rejected', 'cancelled', 'deleted_by_agent') THEN 0::numeric
        ELSE GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0)
      END,
      'agent_id', COALESCE(rr.assigned_agent_id, rr.agent_id),
      'agent_name', ap.full_name,
      'funded_at', rr.funded_at,
      'created_at', rr.created_at
    ) ORDER BY rr.created_at DESC, rr.id
  ), '[]'::jsonb)
  INTO v_plans
  FROM public.rent_requests rr
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
  WHERE v_ll_id IS NOT NULL
    AND rr.landlord_id = v_ll_id;

  -- Payouts history
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', p.id,
      'source', p.source,
      'amount', p.amount,
      'status', p.status,
      'paid_at', p.paid_at,
      'rent_request_id', p.rent_request_id,
      'reference', p.reference
    ) ORDER BY p.paid_at DESC NULLS LAST
  ), '[]'::jsonb)
  INTO v_payouts
  FROM (
    SELECT
      lp.id,
      'landlord_payout'::text AS source,
      COALESCE(lp.amount, 0)::numeric AS amount,
      lp.status,
      COALESCE(lp.finops_disbursed_at, lp.disbursed_at, lp.created_at) AS paid_at,
      lp.rent_request_id,
      COALESCE(lp.finops_momo_reference, lp.external_reference, lp.receipt_number) AS reference
    FROM public.landlord_payouts lp
    WHERE v_ll_id IS NOT NULL
      AND lp.landlord_id = v_ll_id
    UNION ALL
    SELECT
      alfa.id,
      'float_allocation'::text AS source,
      COALESCE(alfa.paid_out_amount, 0)::numeric AS amount,
      alfa.status,
      alfa.updated_at AS paid_at,
      alfa.rent_request_id,
      alfa.funding_reference AS reference
    FROM public.agent_landlord_float_allocations alfa
    WHERE v_ll_id IS NOT NULL
      AND alfa.landlord_id = v_ll_id
      AND alfa.status <> 'cancelled'
      AND COALESCE(alfa.paid_out_amount, 0) > 0
  ) p;

  -- Full call history (landlord_calls effective + awareness calls + Landlord Ops phone verifications), newest first
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'call_id', h.call_id,
      'source', h.source,
      'called_at', h.called_at,
      'dial_started_at', h.dial_started_at,
      'caller_id', h.caller_id,
      'caller_name', h.caller_name,
      'caller_team', h.caller_team,
      'phone_dialed', CASE
        WHEN h.phone_dialed IS NULL OR btrim(h.phone_dialed) = '' THEN NULL
        WHEN v_unmasked THEN h.phone_dialed
        ELSE public.crm_mask_phone(h.phone_dialed)
      END,
      'result', h.result,
      'call_back_at', h.call_back_at,
      'aware_30m', h.aware_30m,
      'landlord_consent', h.landlord_consent,
      'aware_payout_otp', h.aware_payout_otp,
      'explained', h.explained,
      'feedback_category', h.feedback_category,
      'severity', h.severity,
      'note', h.note,
      'tenants_discussed', h.tenants_discussed,
      'rent_request_id', h.rent_request_id,
      'is_amended', h.is_amended,
      'amended_at', h.amended_at,
      'amendment_reason', h.amendment_reason
    ) ORDER BY h.called_at DESC NULLS LAST, h.call_id DESC
  ), '[]'::jsonb)
  INTO v_history
  FROM (
    -- 1. New Landlord Calling Hub calls (effective view with amendments)
    SELECT
      c.id AS call_id,
      'calling_hub'::text AS source,
      c.recorded_at AS called_at,
      c.dial_started_at,
      c.caller_id,
      COALESCE(NULLIF(btrim(cp.full_name), ''), 'Landlord Ops officer') AS caller_name,
      c.caller_team,
      c.phone_dialed,
      c.result,
      c.call_back_at,
      c.aware_30m,
      c.landlord_consent,
      c.aware_payout_otp,
      c.explained,
      c.feedback_category,
      c.severity,
      c.note,
      to_jsonb(c.tenants_discussed) AS tenants_discussed,
      NULL::uuid AS rent_request_id,
      c.is_amended,
      c.amended_at,
      c.amendment_reason
    FROM public.v_landlord_calls_effective c
    LEFT JOIN public.profiles cp ON cp.id = c.caller_id
    WHERE c.voided_at IS NULL
      AND (
        c.landlord_key = v_key
        OR (v_ll_id IS NOT NULL AND c.landlord_id = v_ll_id)
      )

    UNION ALL

    -- 2. Rent Plan pipeline landlord awareness calls
    SELECT
      w.id AS call_id,
      'awareness'::text AS source,
      COALESCE(w.recorded_at, w.dial_started_at) AS called_at,
      w.dial_started_at,
      w.caller_id,
      COALESCE(NULLIF(btrim(wp.full_name), ''), 'Pipeline officer') AS caller_name,
      w.caller_team,
      w.subject_phone AS phone_dialed,
      w.call_result AS result,
      NULL::timestamptz AS call_back_at,
      w.aware_30m,
      w.landlord_consent,
      w.aware_payout_otp,
      w.explained,
      NULL::text AS feedback_category,
      NULL::text AS severity,
      w.note,
      to_jsonb(ARRAY[w.rent_request_id]) AS tenants_discussed,
      w.rent_request_id,
      false AS is_amended,
      NULL::timestamptz AS amended_at,
      NULL::text AS amendment_reason
    FROM public.rent_pipeline_awareness_calls w
    LEFT JOIN public.rent_requests wrr ON wrr.id = w.rent_request_id
    LEFT JOIN public.profiles wp ON wp.id = w.caller_id
    WHERE w.subject_type = 'landlord'
      AND (
        w.subject_user_id::text = v_key
        OR (v_ll_id IS NOT NULL AND (w.subject_user_id = v_ll_id OR wrr.landlord_id = v_ll_id))
        OR (v_reg.user_id IS NOT NULL AND w.subject_user_id = v_reg.user_id)
      )

    UNION ALL

    -- 3. Landlord Ops pipeline verification phone calls on rent_requests
    SELECT
      rr.id AS call_id,
      'verification'::text AS source,
      rr.landlord_ops_reviewed_at AS called_at,
      rr.landlord_ops_reviewed_at AS dial_started_at,
      rr.landlord_ops_reviewed_by AS caller_id,
      COALESCE(NULLIF(btrim(vp.full_name), ''), 'Landlord Ops officer') AS caller_name,
      'landlord_ops'::text AS caller_team,
      COALESCE(v_ll.phone, v_reg.phones[1]) AS phone_dialed,
      CASE WHEN COALESCE(rr.landlord_acknowledged, false) THEN 'answered' ELSE 'no_answer' END AS result,
      NULL::timestamptz AS call_back_at,
      NULL::text AS aware_30m,
      NULL::text AS landlord_consent,
      NULL::text AS aware_payout_otp,
      NULL::text AS explained,
      CASE WHEN COALESCE(rr.landlord_acknowledged, false) THEN 'reached_ok' ELSE NULL END AS feedback_category,
      NULL::text AS severity,
      rr.landlord_call_notes AS note,
      to_jsonb(ARRAY[rr.id]) AS tenants_discussed,
      rr.id AS rent_request_id,
      false AS is_amended,
      NULL::timestamptz AS amended_at,
      NULL::text AS amendment_reason
    FROM public.rent_requests rr
    LEFT JOIN public.profiles vp ON vp.id = rr.landlord_ops_reviewed_by
    WHERE v_ll_id IS NOT NULL
      AND rr.landlord_id = v_ll_id
      AND rr.landlord_called IS TRUE
      AND rr.landlord_verification_method = 'phone_call'
      AND rr.landlord_ops_reviewed_at IS NOT NULL
  ) h;

  -- Active dial marker if someone is currently calling this landlord
  SELECT jsonb_build_object(
    'dial_id', d.id,
    'caller_id', d.caller_id,
    'caller_name', COALESCE(NULLIF(btrim(dp.full_name), ''), 'Landlord Ops officer'),
    'started_at', d.started_at,
    'expires_at', d.expires_at
  )
  INTO v_active_d
  FROM public.landlord_call_dials d
  LEFT JOIN public.profiles dp ON dp.id = d.caller_id
  WHERE d.landlord_key = v_key
    AND d.call_id IS NULL
    AND d.expires_at > now()
  ORDER BY d.started_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'landlord_key', v_key,
    'landlord_id', v_ll_id,
    'user_id', v_reg.user_id,
    'landlord_name', COALESCE(NULLIF(btrim(v_reg.full_name), ''), 'Unnamed Landlord'),
    'phones', COALESCE((
      SELECT jsonb_agg(
        CASE WHEN v_unmasked THEN ph ELSE public.crm_mask_phone(ph) END
      )
      FROM unnest(COALESCE(v_reg.phones, ARRAY[]::text[])) AS ph
    ), '[]'::jsonb),
    'phone_masked', (NOT v_unmasked),
    'region', v_reg.region,
    'district', v_reg.district,
    'village', v_ll.village,
    'property_address', v_ll.property_address,
    'verified', (v_reg.verification_status = 'verified'),
    'verification_status', v_reg.verification_status,
    'needs_review', COALESCE(v_reg.needs_review, false),
    'registered_at', v_reg.registered_at,
    'houses_count', COALESCE(v_reg.houses_count, 0),
    'live_rent_plans', COALESCE(v_reg.active_rent_plans, 0),
    'rent_plan_value', COALESCE(v_reg.plan_rent_total, 0),
    'registering_agent', v_agent,
    'caretaker', v_caretaker,
    'payout_details', v_payout_det,
    'houses', v_houses,
    'tenants_and_plans', v_plans,
    'payouts', v_payouts,
    'call_history', v_history,
    'active_dial', v_active_d
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_hub_detail(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_hub_detail(text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 11. Function: public.landlord_hub_stats()
--     Top strip metrics in Kampala time:
--     - calls_today
--     - answered_today
--     - answered_rate_pct
--     - call_backs_due
--     - call_backs_overdue
--     - live_plan_landlords_total
--     - live_plan_landlords_never_called
--     - landlords_reached_this_week
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_hub_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_now                 timestamptz := now();
  v_kampala_today       date := (v_now AT TIME ZONE 'Africa/Kampala')::date;
  v_today_start         timestamptz := (v_kampala_today::timestamp AT TIME ZONE 'Africa/Kampala');
  v_dow                 int := extract(dow FROM v_kampala_today)::int;
  v_week_start_date     date := v_kampala_today - ((v_dow - 3 + 7) % 7); -- Wednesday-Tuesday Kampala week
  v_week_start          timestamptz := (v_week_start_date::timestamp AT TIME ZONE 'Africa/Kampala');
  v_calls_today         integer := 0;
  v_answered_today      integer := 0;
  v_answered_rate       numeric := 0;
  v_callbacks_due       integer := 0;
  v_callbacks_overdue   integer := 0;
  v_live_total          integer := 0;
  v_live_never_called   integer := 0;
  v_reached_this_week   integer := 0;
BEGIN
  IF NOT public._landlord_hub_can_read() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: you are not authorised to view Landlord Calling Hub stats'
      USING ERRCODE = '42501';
  END IF;

  -- Calls today & answered rate from landlord_calls (effective, non-voided)
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE c.result = 'answered')::integer
  INTO v_calls_today, v_answered_today
  FROM public.v_landlord_calls_effective c
  WHERE c.voided_at IS NULL
    AND c.recorded_at >= v_today_start;

  IF v_calls_today > 0 THEN
    v_answered_rate := round((v_answered_today::numeric * 100.0) / v_calls_today, 1);
  ELSE
    v_answered_rate := 0;
  END IF;

  -- Call-backs due and overdue across landlords whose latest effective hub call is 'call_back'
  WITH latest_hub AS (
    SELECT DISTINCT ON (c.landlord_key)
      c.landlord_key,
      c.result,
      c.call_back_at
    FROM public.v_landlord_calls_effective c
    WHERE c.voided_at IS NULL
    ORDER BY c.landlord_key, c.recorded_at DESC, c.id DESC
  )
  SELECT
    count(*) FILTER (WHERE lh.result = 'call_back')::integer,
    count(*) FILTER (WHERE lh.result = 'call_back' AND lh.call_back_at IS NOT NULL AND lh.call_back_at < v_now)::integer
  INTO v_callbacks_due, v_callbacks_overdue
  FROM latest_hub lh;

  -- Live-plan landlords total & never called (consistent with v_landlord_registry_all + landlord_calls)
  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE reg.last_called_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.v_landlord_calls_effective c
          WHERE c.voided_at IS NULL
            AND c.landlord_key = reg.landlord_key_text
        )
    )::integer
  INTO v_live_total, v_live_never_called
  FROM public.mv_landlord_hub_registry reg
  WHERE reg.active_rent_plans > 0;

  -- Distinct landlords reached this week (hub answered/call_back + awareness answered + verification acknowledged)
  SELECT count(DISTINCT reached_key)::integer
    INTO v_reached_this_week
  FROM (
    SELECT c.landlord_key AS reached_key
    FROM public.v_landlord_calls_effective c
    WHERE c.voided_at IS NULL
      AND c.recorded_at >= v_week_start
      AND c.result IN ('answered', 'call_back')
    UNION
    SELECT COALESCE(w.subject_user_id, rr.landlord_id)::text AS reached_key
    FROM public.rent_pipeline_awareness_calls w
    LEFT JOIN public.rent_requests rr ON rr.id = w.rent_request_id
    WHERE w.subject_type = 'landlord'
      AND w.call_result = 'answered'
      AND COALESCE(w.recorded_at, w.dial_started_at) >= v_week_start
      AND COALESCE(w.subject_user_id, rr.landlord_id) IS NOT NULL
    UNION
    SELECT q.landlord_id::text AS reached_key
    FROM public.rent_requests q
    WHERE q.landlord_id IS NOT NULL
      AND q.landlord_called IS TRUE
      AND q.landlord_verification_method = 'phone_call'
      AND COALESCE(q.landlord_acknowledged, false) IS TRUE
      AND q.landlord_ops_reviewed_at >= v_week_start
  ) wk
  WHERE reached_key IS NOT NULL;

  RETURN jsonb_build_object(
    'calls_today', v_calls_today,
    'answered_today', v_answered_today,
    'answered_rate_pct', v_answered_rate,
    'call_backs_due', v_callbacks_due,
    'call_backs_overdue', v_callbacks_overdue,
    'live_plan_landlords_total', v_live_total,
    'live_plan_landlords_never_called', v_live_never_called,
    'landlords_reached_this_week', v_reached_this_week,
    'week_start', v_week_start_date,
    'kampala_today', v_kampala_today
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_hub_stats() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_hub_stats() TO authenticated;
