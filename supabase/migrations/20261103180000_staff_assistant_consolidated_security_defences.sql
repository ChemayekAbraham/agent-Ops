-- =============================================================================
-- Zoe (My Space Staff Assistant) — Consolidated Security Defences, Schema
-- Migration Ledger Reconciliation, Analyst Column Allow-List, Teaching Loop
-- Attribution, and Push/Voice Consent Preferences
-- Version: 20261103180000 (unique across supabase/migrations/ and schema_migrations)
-- =============================================================================

BEGIN;

-- 1. Reconcile supabase_migrations.schema_migrations for all applied Zoe migrations
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name)
    VALUES
      ('20261031120000', 'staff_assistant_prompt1_reliability_and_real_use_dashboard'),
      ('20261031140000', 'staff_assistant_prompt2_files_coaching_projects_and_zoe_ro'),
      ('20261031160000', 'staff_assistant_prompt3_teaching_loop_kb200_and_role_goals'),
      ('20261103180000', 'staff_assistant_consolidated_security_defences')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END
$$;

-- 1b. Reconcile public.staff_assistant_research_logs (idempotent DDL + RLS + mfa_required_for_staff)
CREATE TABLE IF NOT EXISTS public.staff_assistant_research_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.staff_assistant_conversations(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'brave',
  query_text text NOT NULL,
  urls_fetched text[] NOT NULL DEFAULT '{}'::text[],
  source_count integer NOT NULL DEFAULT 0,
  cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  kampala_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'Africa/Kampala')::date),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.staff_assistant_research_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.staff_assistant_research_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_research_logs TO authenticated;
GRANT ALL ON TABLE public.staff_assistant_research_logs TO service_role;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_research_logs;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_research_logs
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (
    public.staff_assistant_has_access()
    AND COALESCE((SELECT auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
  )
  WITH CHECK (
    public.staff_assistant_has_access()
    AND COALESCE((SELECT auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
  );

DROP POLICY IF EXISTS staff_assistant_research_logs_select_own_or_reviewer ON public.staff_assistant_research_logs;
CREATE POLICY staff_assistant_research_logs_select_own_or_reviewer
  ON public.staff_assistant_research_logs
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.staff_assistant_crm_can_review()
  );

-- 2. Teaching Loop Data-Poisoning Defence: explicit created_by and approved_by
--    attribution + 90-day review expiry on staff_assistant_knowledge_base
ALTER TABLE public.staff_assistant_knowledge_base
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

UPDATE public.staff_assistant_knowledge_base
SET
  created_by = COALESCE(created_by, updated_by, reviewed_by),
  approved_by = COALESCE(approved_by, reviewed_by, updated_by)
WHERE created_by IS NULL OR approved_by IS NULL;

-- 3. Web Push Topic Consent & Voice Disclosure Preferences
ALTER TABLE public.staff_assistant_preferences
  ADD COLUMN IF NOT EXISTS web_push_morning_brief_topic boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS web_push_taught_updates_topic boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS web_push_soft_prompt_dismissed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_disclosure_acknowledged_at timestamptz;

-- Replace 1-arg staff_assistant_can_send_web_push with backward-compatible 2-arg
-- version (p_user_id uuid, p_topic text DEFAULT 'morning_brief') that enforces
-- off-by-default topic opt-in and the 2-per-Kampala-day cap.
DROP FUNCTION IF EXISTS public.staff_assistant_can_send_web_push(uuid);

CREATE OR REPLACE FUNCTION public.staff_assistant_can_send_web_push(
  p_user_id uuid,
  p_topic text DEFAULT 'morning_brief'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_prefs public.staff_assistant_preferences;
  v_topic text := LOWER(btrim(COALESCE(p_topic, 'morning_brief')));
  v_topic_enabled boolean := false;
  v_count integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'missing_user');
  END IF;

  SELECT * INTO v_prefs
  FROM public.staff_assistant_preferences
  WHERE user_id = p_user_id;

  IF v_prefs.user_id IS NULL OR NOT v_prefs.web_push_enabled OR v_prefs.web_push_muted THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'opt_in_disabled_or_muted');
  END IF;

  v_topic_enabled := CASE v_topic
    WHEN 'morning_brief' THEN COALESCE(v_prefs.web_push_morning_brief_topic, false)
    WHEN 'taught_updates' THEN COALESCE(v_prefs.web_push_taught_updates_topic, false)
    ELSE false
  END;

  IF NOT v_topic_enabled THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'topic_not_opted_in',
      'topic', v_topic
    );
  END IF;

  v_count := CASE
    WHEN v_prefs.web_push_sent_kampala_date = v_today THEN COALESCE(v_prefs.web_push_sent_today_count, 0)
    ELSE 0
  END;

  IF v_count >= 2 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'daily_cap_reached',
      'sent_today', v_count,
      'daily_cap', 2
    );
  END IF;

  UPDATE public.staff_assistant_preferences
  SET
    web_push_sent_kampala_date = v_today,
    web_push_sent_today_count = v_count + 1,
    updated_at = now()
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'allowed', true,
    'topic', v_topic,
    'sent_today', v_count + 1,
    'daily_cap', 2
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_can_send_web_push(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_send_web_push(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_assistant_update_push_and_voice_prefs(
  p_web_push_enabled boolean DEFAULT NULL,
  p_web_push_muted boolean DEFAULT NULL,
  p_morning_brief_topic boolean DEFAULT NULL,
  p_taught_updates_topic boolean DEFAULT NULL,
  p_acknowledge_voice_disclosure boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_row public.staff_assistant_preferences;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required.'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.staff_assistant_preferences (
    user_id,
    web_push_enabled,
    web_push_muted,
    web_push_morning_brief_topic,
    web_push_taught_updates_topic,
    voice_disclosure_acknowledged_at,
    updated_at
  )
  VALUES (
    v_uid,
    COALESCE(p_web_push_enabled, false),
    COALESCE(p_web_push_muted, false),
    COALESCE(p_morning_brief_topic, false),
    COALESCE(p_taught_updates_topic, false),
    CASE WHEN COALESCE(p_acknowledge_voice_disclosure, false) THEN now() ELSE NULL END,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    web_push_enabled = COALESCE(p_web_push_enabled, public.staff_assistant_preferences.web_push_enabled),
    web_push_muted = COALESCE(p_web_push_muted, public.staff_assistant_preferences.web_push_muted),
    web_push_morning_brief_topic = COALESCE(
      p_morning_brief_topic,
      public.staff_assistant_preferences.web_push_morning_brief_topic
    ),
    web_push_taught_updates_topic = COALESCE(
      p_taught_updates_topic,
      public.staff_assistant_preferences.web_push_taught_updates_topic
    ),
    voice_disclosure_acknowledged_at = CASE
      WHEN COALESCE(p_acknowledge_voice_disclosure, false)
        THEN COALESCE(public.staff_assistant_preferences.voice_disclosure_acknowledged_at, now())
      ELSE public.staff_assistant_preferences.voice_disclosure_acknowledged_at
    END,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'web_push_enabled', v_row.web_push_enabled,
    'web_push_muted', v_row.web_push_muted,
    'web_push_morning_brief_topic', v_row.web_push_morning_brief_topic,
    'web_push_taught_updates_topic', v_row.web_push_taught_updates_topic,
    'voice_disclosure_acknowledged_at', v_row.voice_disclosure_acknowledged_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_update_push_and_voice_prefs(boolean, boolean, boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_update_push_and_voice_prefs(boolean, boolean, boolean, boolean, boolean) TO authenticated;

-- 4. Update staff_assistant_teach_from_review_queue to record created_by,
--    approved_by, reviewed_by_name, reviewed_at, and 90-day expires_at
CREATE OR REPLACE FUNCTION public.staff_assistant_teach_from_review_queue(
  p_unanswered_id uuid DEFAULT NULL,
  p_slug text DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_category text DEFAULT 'process_explanation',
  p_department text DEFAULT 'general',
  p_summary text DEFAULT NULL,
  p_body text DEFAULT NULL,
  p_measurement_gotcha text DEFAULT NULL,
  p_official_source text DEFAULT NULL,
  p_screen_path text DEFAULT NULL,
  p_keywords text[] DEFAULT '{}'::text[],
  p_synonyms text[] DEFAULT '{}'::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_lead_name text;
  v_dept_label text;
  v_kb_id uuid;
  v_expires timestamptz := now() + interval '90 days';
  v_slug text := LOWER(regexp_replace(btrim(COALESCE(p_slug, '')), '[^a-z0-9_]+', '_', 'g'));
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_crm_can_review() THEN
    RAISE EXCEPTION 'Not authorized: department lead or reviewer role required to teach Zoe.'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(NULLIF(btrim(full_name), ''), 'Department Lead')
  INTO v_lead_name
  FROM public.profiles
  WHERE id = v_uid;

  v_dept_label := CASE LOWER(btrim(COALESCE(p_department, 'general')))
    WHEN 'tenant_ops' THEN 'Tenant Ops'
    WHEN 'landlord_ops' THEN 'Landlord Ops'
    WHEN 'calling_center' THEN 'Calling Center'
    WHEN 'agent_ops' THEN 'Agent Ops'
    WHEN 'partner_ops' THEN 'Partner Ops'
    WHEN 'financial_ops' THEN 'Financial Ops'
    WHEN 'hr' THEN 'HR'
    WHEN 'coo_ceo' THEN 'Operations Leadership'
    ELSE 'Operations'
  END;

  IF char_length(v_slug) < 3 THEN
    v_slug := 'taught_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  END IF;

  INSERT INTO public.staff_assistant_knowledge_base (
    slug,
    title,
    category,
    department,
    summary,
    body,
    measurement_gotcha,
    official_source,
    screen_path,
    keywords,
    synonyms,
    review_status,
    created_by,
    approved_by,
    reviewed_by,
    reviewed_by_name,
    reviewed_at,
    expires_at,
    updated_by,
    source_unanswered_id,
    updated_at
  )
  VALUES (
    left(v_slug, 80),
    btrim(COALESCE(p_title, 'Taught Knowledge Entry')),
    CASE
      WHEN p_category IN ('glossary', 'product_policy', 'process_explanation', 'where_to_find', 'measurement_gotcha')
      THEN p_category
      ELSE 'process_explanation'
    END,
    LOWER(btrim(COALESCE(p_department, 'general'))),
    btrim(COALESCE(p_summary, '')),
    btrim(COALESCE(p_body, '')),
    NULLIF(btrim(COALESCE(p_measurement_gotcha, '')), ''),
    NULLIF(btrim(COALESCE(p_official_source, '')), ''),
    NULLIF(btrim(COALESCE(p_screen_path, '')), ''),
    COALESCE(p_keywords, '{}'::text[]),
    COALESCE(p_synonyms, '{}'::text[]),
    'published',
    v_uid,
    v_uid,
    v_uid,
    COALESCE(v_lead_name, 'Department Lead') || ' (' || v_dept_label || ')',
    now(),
    v_expires,
    v_uid,
    p_unanswered_id,
    now()
  )
  ON CONFLICT (slug) DO UPDATE
  SET
    title = EXCLUDED.title,
    category = EXCLUDED.category,
    department = EXCLUDED.department,
    summary = EXCLUDED.summary,
    body = EXCLUDED.body,
    measurement_gotcha = EXCLUDED.measurement_gotcha,
    official_source = EXCLUDED.official_source,
    screen_path = EXCLUDED.screen_path,
    keywords = EXCLUDED.keywords,
    synonyms = EXCLUDED.synonyms,
    review_status = 'published',
    created_by = COALESCE(public.staff_assistant_knowledge_base.created_by, v_uid),
    approved_by = v_uid,
    reviewed_by = v_uid,
    reviewed_by_name = EXCLUDED.reviewed_by_name,
    reviewed_at = now(),
    expires_at = v_expires,
    updated_by = v_uid,
    source_unanswered_id = COALESCE(EXCLUDED.source_unanswered_id, public.staff_assistant_knowledge_base.source_unanswered_id),
    updated_at = now()
  RETURNING id INTO v_kb_id;

  IF p_unanswered_id IS NOT NULL THEN
    UPDATE public.staff_assistant_unanswered
    SET
      status = 'resolved',
      reviewed_by = v_uid,
      reviewed_at = now(),
      review_note = 'Taught and published to knowledge base (' || v_slug || ')',
      taught_knowledge_id = v_kb_id,
      taught_by_name = COALESCE(v_lead_name, 'Department Lead') || ' (' || v_dept_label || ')',
      taught_at = now()
    WHERE id = p_unanswered_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'knowledge_id', v_kb_id,
    'slug', v_slug,
    'created_by', v_uid,
    'approved_by', v_uid,
    'reviewed_by_name', COALESCE(v_lead_name, 'Department Lead') || ' (' || v_dept_label || ')',
    'reviewed_at', now(),
    'expires_at', v_expires
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_teach_from_review_queue(uuid, text, text, text, text, text, text, text, text, text, text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_teach_from_review_queue(uuid, text, text, text, text, text, text, text, text, text, text[], text[]) TO authenticated;

-- 5. Analyst View-Security & Column Allow-List Defence in zoe_ro_validate_query
--    Checks:
--      (a) every referenced view is in public.staff_assistant_data_catalog
--      (b) every referenced zoe_ro view has security_invoker = true in pg_class
--      (c) every table-/alias-qualified column reference <qualifier>.<column>
--          is in the explicit allow-list of columns for the referenced zoe_ro views
CREATE OR REPLACE FUNCTION public.zoe_ro_validate_query(
  p_sql text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_raw text := btrim(COALESCE(p_sql, ''));
  v_clean text;
  v_no_literals text;
  v_lower text;
  v_cte_names text[] := ARRAY[]::text[];
  v_ref_views text[] := ARRAY[]::text[];
  v_ref_areas text[] := ARRAY[]::text[];
  v_allowed_cols text[] := ARRAY[]::text[];
  v_cte_aliases text[] := ARRAY[]::text[];
  v_match text[];
  v_fn_name text;
  v_rel_token text;
  v_view_short text;
  v_view_area text;
  v_requires_aal2 boolean := false;
  v_has_security_invoker boolean := false;
  v_qual text;
  v_col text;
  v_allowed_functions constant text[] := ARRAY[
    'count', 'sum', 'avg', 'min', 'max', 'array_agg', 'string_agg', 'bool_and', 'bool_or', 'every',
    'coalesce', 'nullif', 'greatest', 'least', 'abs', 'round', 'ceil', 'ceiling', 'floor', 'trunc', 'sign', 'mod', 'power', 'sqrt',
    'lower', 'upper', 'initcap', 'btrim', 'trim', 'ltrim', 'rtrim', 'left', 'right', 'length', 'char_length', 'substr', 'substring', 'replace', 'concat', 'concat_ws', 'split_part', 'strpos', 'position',
    'date_trunc', 'date_part', 'extract', 'age', 'to_char', 'to_date', 'now', 'current_date', 'current_timestamp', 'make_date', 'make_interval', 'justify_days', 'justify_hours', 'justify_interval',
    'row_number', 'rank', 'dense_rank', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'percentile_cont', 'percentile_disc',
    'cast', 'in', 'not', 'exists', 'over', 'filter', 'within', 'values', 'unnest',
    'as', 'where', 'and', 'or', 'when', 'then', 'else', 'case', 'on', 'from', 'join', 'having', 'by', 'select', 'distinct', 'any', 'some', 'all', 'between',
    'jsonb_build_object', 'jsonb_agg', 'to_jsonb'
  ];
BEGIN
  IF v_raw = '' THEN
    RAISE EXCEPTION 'Analyst query rejected: SQL query cannot be empty.'
      USING ERRCODE = '22023';
  END IF;

  IF length(v_raw) > 4000 THEN
    RAISE EXCEPTION 'Analyst query rejected: SQL query exceeds 4,000 character limit.'
      USING ERRCODE = '22023';
  END IF;

  IF v_raw ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RAISE EXCEPTION 'Analyst query rejected: control characters are forbidden.'
      USING ERRCODE = '22023';
  END IF;

  IF v_raw ~ '--' OR v_raw ~ '/\*' OR v_raw ~ '\*/' THEN
    RAISE EXCEPTION 'Analyst query rejected: SQL comments (-- or /* */) are not allowed.'
      USING ERRCODE = '22023';
  END IF;

  v_clean := regexp_replace(v_raw, ';\s*$', '');
  IF position(';' IN v_clean) > 0 THEN
    RAISE EXCEPTION 'Analyst query rejected: multiple statements or semicolon chaining are forbidden.'
      USING ERRCODE = '22023';
  END IF;

  IF v_clean ~* '(ignore\s+(all\s+|any\s+)?(previous|prior)\s+instructions|<UNTRUSTED_TOOL_DATA|<UNTRUSTED_FILE_ATTACHMENT|SUPABASE_SERVICE_ROLE_KEY|LOVABLE_API_KEY|system\s+prompt|developer\s+mode|jailbreak)' THEN
    RAISE EXCEPTION 'Analyst query rejected: prompt injection or secret extraction pattern detected.'
      USING ERRCODE = '42501';
  END IF;

  v_no_literals := regexp_replace(v_clean, '''(?:''''|[^''])*''', '''''', 'g');
  v_lower := lower(btrim(v_no_literals));

  IF v_lower !~ '^(select|with)\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: only a single SELECT or WITH ... SELECT statement is allowed.'
      USING ERRCODE = '22023';
  END IF;

  IF v_lower ~ '^with\M' AND v_lower !~ '\mselect\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: WITH query must contain a SELECT statement.'
      USING ERRCODE = '22023';
  END IF;

  IF v_lower ~ '\mwith\s+recursive\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: WITH RECURSIVE is not allowed.'
      USING ERRCODE = '22023';
  END IF;

  IF v_lower ~ '\m(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|set|reset|show|discard|begin|commit|rollback|savepoint|release|lock|vacuum|analyze|cluster|reindex|explain|prepare|deallocate|execute|call|do|listen|notify|unlisten|load|import|security|owner|into)\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: write, DDL, COPY, SET, or administrative SQL keywords are forbidden.'
      USING ERRCODE = '42501';
  END IF;

  IF v_lower ~ '\mfor\s+(update|share|no\s+key\s+update|key\s+share)\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: row-locking clauses are forbidden.'
      USING ERRCODE = '42501';
  END IF;

  IF v_lower ~ '\m(pg_sleep|pg_sleep_for|pg_sleep_until|dblink|dblink_exec|dblink_connect|lo_import|lo_export|lo_unlink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|set_config|current_setting|pg_advisory_lock|pg_try_advisory_lock|query_to_xml|table_to_xml|database_to_xml)\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: forbidden system, sleep, or network function.'
      USING ERRCODE = '42501';
  END IF;

  IF v_lower ~ '\m(password|pin_hash|otp|secret|token|activation_token|portfolio_pin|national_id|nin|id_image_hash|selfie_image_hash|signup_device_fp|verification_pin_1|verification_pin_2|aware_payout_otp|aware_merchant_codes|unmasked_phone|raw_phone|account_number|mobile_money_number|subject_phone|caretaker_phone|lc1_chairperson_phone|whatsapp_number|phone_number)\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: PII, phone, account number, or secret columns are forbidden.'
      USING ERRCODE = '42501';
  END IF;

  IF v_lower ~ '\mcross\s+join\M'
     OR v_lower ~ '\mfrom\s+zoe_ro\.[a-z0-9_]+(?:\s+(?:as\s+)?[a-z0-9_]+)?\s*,'
     OR v_lower ~ '\mjoin\s+[^\n]+?\mon\s*\(?\s*(true|1\s*=\s*1)\s*\)?' THEN
    RAISE EXCEPTION 'Analyst query rejected: CROSS JOIN or unconstrained Cartesian join is forbidden.'
      USING ERRCODE = '22023';
  END IF;

  IF v_lower ~ '\m(public|pg_catalog|information_schema|auth|storage|vault|extensions|supabase_functions|net|cron|pgsodium|realtime)\s*\.' THEN
    RAISE EXCEPTION 'Analyst query rejected: objects outside the zoe_ro schema are forbidden.'
      USING ERRCODE = '42501';
  END IF;

  -- Collect CTE names defined in `WITH <cte> AS (` or `, <cte> AS (`
  FOR v_match IN
    SELECT regexp_matches(v_lower, '(?:\mwith\s+|\s*,\s*)([a-z_][a-z0-9_]*)\s+as\s*\(', 'g')
  LOOP
    v_cte_names := array_append(v_cte_names, v_match[1]);
  END LOOP;

  -- Collect SELECT column aliases (`AS <alias>`) so CTE/subquery references can use them
  FOR v_match IN
    SELECT regexp_matches(v_lower, '\mas\s+([a-z_][a-z0-9_]*)\M', 'g')
  LOOP
    IF NOT (v_match[1] = ANY(v_cte_aliases)) THEN
      v_cte_aliases := array_append(v_cte_aliases, v_match[1]);
    END IF;
  END LOOP;

  -- Inspect every FROM / JOIN target: must be a declared CTE or `zoe_ro.<view>`
  FOR v_match IN
    SELECT regexp_matches(v_lower, '\m(?:from|join)\s+([a-z_][a-z0-9_.]*)', 'g')
  LOOP
    v_rel_token := v_match[1];
    IF v_rel_token = ANY(v_cte_names) THEN
      CONTINUE;
    END IF;
    IF v_rel_token !~ '^zoe_ro\.[a-z0-9_]+$' THEN
      IF v_lower ~ ('\m(?:extract|trim|btrim|ltrim|rtrim|substring)\s*\([^)]*\mfrom\s+' || regexp_replace(v_rel_token, '([.])', '\\\1', 'g')) THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'Analyst query rejected: base table or non-zoe_ro object "%" is forbidden. Query zoe_ro.<view> only.', v_rel_token
        USING ERRCODE = '42501';
    END IF;

    SELECT c.role_area, c.requires_aal2
      INTO v_view_area, v_requires_aal2
      FROM public.staff_assistant_data_catalog c
     WHERE c.view_name = v_rel_token;

    IF v_view_area IS NULL THEN
      RAISE EXCEPTION 'Analyst query rejected: view "%" is not in the approved zoe_ro catalog.', v_rel_token
        USING ERRCODE = '42501';
    END IF;

    -- Verify the zoe_ro view has security_invoker = true in pg_class
    v_view_short := split_part(v_rel_token, '.', 2);
    SELECT EXISTS (
      SELECT 1
      FROM pg_class cls
      JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
      WHERE nsp.nspname = 'zoe_ro'
        AND cls.relname = v_view_short
        AND cls.relkind = 'v'
        AND 'security_invoker=true' = ANY(COALESCE(cls.reloptions, ARRAY[]::text[]))
    ) INTO v_has_security_invoker;

    IF NOT COALESCE(v_has_security_invoker, false) THEN
      RAISE EXCEPTION 'Analyst query rejected: view "%" does not enforce security_invoker = true.', v_rel_token
        USING ERRCODE = '42501';
    END IF;

    IF NOT (v_rel_token = ANY(v_ref_views)) THEN
      v_ref_views := array_append(v_ref_views, v_rel_token);
    END IF;
    IF NOT (v_view_area = ANY(v_ref_areas)) THEN
      v_ref_areas := array_append(v_ref_areas, v_view_area);
    END IF;
  END LOOP;

  IF array_length(v_ref_views, 1) IS NULL OR array_length(v_ref_views, 1) = 0 THEN
    RAISE EXCEPTION 'Analyst query rejected: query must read from at least one approved zoe_ro.<view>.'
      USING ERRCODE = '22023';
  END IF;

  -- Build the explicit column allow-list for the referenced zoe_ro views from
  -- public.staff_assistant_data_catalog (and information_schema.columns for those views)
  SELECT COALESCE(array_agg(DISTINCT lower(col_name)), ARRAY[]::text[])
    INTO v_allowed_cols
    FROM (
      SELECT jsonb_array_elements_text(c.columns) AS col_name
      FROM public.staff_assistant_data_catalog c
      WHERE c.view_name = ANY(v_ref_views)
        AND jsonb_typeof(c.columns) = 'array'
      UNION
      SELECT ic.column_name AS col_name
      FROM information_schema.columns ic
      WHERE ic.table_schema = 'zoe_ro'
        AND ('zoe_ro.' || ic.table_name) = ANY(v_ref_views)
    ) allowed_union;

  -- Check every qualified identifier `<qualifier>.<column>` against the explicit column allow-list
  FOR v_match IN
    SELECT regexp_matches(v_lower, '([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)', 'g')
  LOOP
    v_qual := v_match[1];
    v_col := v_match[2];
    IF v_qual = 'zoe_ro' THEN
      -- `zoe_ro.<view_name>` was already checked above
      CONTINUE;
    END IF;
    IF NOT (v_col = ANY(v_allowed_cols)) AND NOT (v_col = ANY(v_cte_aliases)) THEN
      RAISE EXCEPTION 'Analyst query rejected: column "%.%" is not in the approved zoe_ro column allow-list for %.',
        v_qual, v_col, array_to_string(v_ref_views, ', ')
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Check every function call `<ident>(` against the strict function allow-list
  FOR v_match IN
    SELECT regexp_matches(v_lower, '([a-z_][a-z0-9_.]*)\s*\(', 'g')
  LOOP
    v_fn_name := v_match[1];
    IF v_fn_name = ANY(v_cte_names) THEN
      CONTINUE;
    END IF;
    IF NOT (v_fn_name = ANY(v_allowed_functions)) THEN
      RAISE EXCEPTION 'Analyst query rejected: function "%" is not in the Analyst allow-list.', v_fn_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'clean_sql', v_clean,
    'views', to_jsonb(v_ref_views),
    'role_areas', to_jsonb(v_ref_areas),
    'allowed_columns', to_jsonb(v_allowed_cols)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.zoe_ro_validate_query(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.zoe_ro_validate_query(text) TO authenticated;

-- 6. Ensure staff_assistant_can_user_read_report authorizes coaching, KB search,
--    and taught-updates RPCs for staff
CREATE OR REPLACE FUNCTION public.staff_assistant_can_user_read_report(
  p_user_id uuid,
  p_report_rpc text,
  p_owner_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_rpc text := lower(btrim(COALESCE(p_report_rpc, '')));
  v_is_calling_member boolean;
BEGIN
  IF p_user_id IS NULL OR v_rpc = '' THEN
    RETURN false;
  END IF;

  IF NOT public._has_enabled_role(
    p_user_id,
    ARRAY[
      'employee', 'operations', 'tenant_ops', 'agent_ops', 'landlord_ops',
      'partner_ops', 'financial_ops', 'crm', 'hr', 'manager',
      'cfo', 'coo', 'ceo', 'cto', 'admin', 'super_admin'
    ]
  ) THEN
    RETURN false;
  END IF;

  IF v_rpc LIKE 'assistant_staff_my_%' THEN
    IF p_owner_id IS NOT NULL AND p_user_id <> p_owner_id THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF v_rpc IN (
    'assistant_staff_welile_glossary',
    'assistant_staff_get_glossary',
    'assistant_staff_data_catalog',
    'assistant_staff_get_data_catalog',
    'assistant_staff_search_knowledge_base'
  ) THEN
    RETURN true;
  END IF;

  IF v_rpc = 'assistant_staff_team_work_summary' THEN
    RETURN public._has_enabled_role(
      p_user_id,
      ARRAY[
        'tenant_ops', 'landlord_ops', 'agent_ops', 'partner_ops', 'financial_ops',
        'crm', 'hr', 'manager', 'coo', 'ceo', 'cfo', 'cto', 'super_admin'
      ]
    );
  END IF;

  IF v_rpc LIKE 'assistant_staff_tops_%'
     OR v_rpc = 'assistant_staff_insight_desk_wait_times' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND (
        public.is_ops_role(p_user_id)
        OR public._has_enabled_role(
          p_user_id,
          ARRAY['tenant_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
        )
      );
  END IF;

  IF v_rpc LIKE 'assistant_staff_lops_%' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND (
        public.is_ops_role(p_user_id)
        OR public._has_enabled_role(
          p_user_id,
          ARRAY['landlord_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
        )
      );
  END IF;

  IF v_rpc LIKE 'assistant_staff_aops_%'
     OR v_rpc = 'assistant_staff_insight_collection_coverage_trends' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['agent_ops', 'tenant_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
      );
  END IF;

  IF v_rpc LIKE 'assistant_staff_pops_%' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['partner_ops', 'financial_ops', 'cfo', 'ceo', 'coo', 'manager', 'super_admin']
      );
  END IF;

  IF v_rpc = 'assistant_staff_pso_cohort_performance' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['hr', 'coo', 'ceo', 'super_admin']
      );
  END IF;

  IF v_rpc IN (
    'assistant_staff_cfo_treasury_cash_position',
    'assistant_staff_cfo_receivables_and_payables',
    'assistant_staff_cfo_seven_day_expenses',
    'assistant_staff_insight_payout_delays'
  ) THEN
    RETURN public.can_view_finance_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['cfo', 'ceo', 'coo', 'manager', 'financial_ops', 'cto', 'super_admin']
      );
  END IF;

  IF v_rpc = 'assistant_staff_cfo_money_flow_summary' THEN
    RETURN public.can_view_finance_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['cfo', 'ceo', 'super_admin']
      );
  END IF;

  IF v_rpc = 'assistant_staff_cfo_budget_revised_position' THEN
    RETURN public.can_view_finance_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['cfo', 'ceo', 'coo', 'super_admin']
      );
  END IF;

  IF v_rpc LIKE 'assistant_staff_fops_%' THEN
    RETURN public.can_view_finance_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['financial_ops', 'cfo', 'ceo', 'coo', 'super_admin']
      );
  END IF;

  IF v_rpc IN ('assistant_staff_coo_overview', 'assistant_staff_ceo_growth_and_approvals') THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['coo', 'ceo', 'cfo', 'manager', 'super_admin']
      );
  END IF;

  IF v_rpc IN (
    'assistant_staff_hr_calling_detailed_report',
    'assistant_staff_insight_calling_reach_and_themes'
  ) THEN
    v_is_calling_member := p_user_id IN (
      '5295252d-f477-42a9-92f5-af56e503e33d'::uuid,
      'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid,
      'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid,
      'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid
    );
    RETURN public.can_view_staff_reports(p_user_id)
      AND (
        v_is_calling_member
        OR public._has_enabled_role(
          p_user_id,
          ARRAY['hr', 'coo', 'cfo', 'ceo', 'manager', 'operations', 'super_admin']
        )
      );
  END IF;

  IF v_rpc IN (
    'assistant_staff_hr_contracts_and_birthdays',
    'assistant_staff_hr_payroll_cost_by_department'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['hr', 'coo', 'ceo', 'cfo', 'super_admin']
      );
  END IF;

  IF v_rpc = 'assistant_staff_insight_zoe_feedback_themes' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['crm', 'cto', 'coo', 'ceo', 'cfo', 'hr', 'manager', 'super_admin']
      );
  END IF;

  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) TO authenticated, service_role;

-- 7. Update staff_assistant_health() so it verifies all 21 Zoe tables,
--    all 22 zoe_ro views, and all consolidated RPCs
CREATE OR REPLACE FUNCTION public.staff_assistant_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_required_tables constant text[] := ARRAY[
    'staff_assistant_config',
    'staff_assistant_conversations',
    'staff_assistant_messages',
    'staff_assistant_feedback',
    'staff_assistant_unanswered',
    'staff_assistant_reminders',
    'staff_assistant_schedules',
    'staff_assistant_preferences',
    'staff_assistant_drafts',
    'staff_assistant_insights',
    'staff_assistant_ideas',
    'staff_assistant_notes',
    'staff_assistant_glossary',
    'staff_assistant_data_catalog',
    'staff_assistant_queries',
    'staff_assistant_research_logs',
    'staff_assistant_learning_log',
    'staff_assistant_knowledge_base',
    'staff_assistant_projects',
    'staff_assistant_uploads',
    'staff_assistant_kb_zero_hits'
  ];
  v_required_columns constant text[] := ARRAY[
    'staff_assistant_config.model_fast',
    'staff_assistant_config.model_deep',
    'staff_assistant_config.temperature',
    'staff_assistant_config.max_tokens',
    'staff_assistant_config.max_model_rounds',
    'staff_assistant_config.max_tool_calls',
    'staff_assistant_config.max_deep_model_rounds',
    'staff_assistant_config.max_deep_tool_calls',
    'staff_assistant_config.max_cost_usd_per_question',
    'staff_assistant_config.web_research_enabled',
    'staff_assistant_conversations.hidden_by_user',
    'staff_assistant_conversations.rolling_summary',
    'staff_assistant_conversations.project_id',
    'staff_assistant_messages.hidden_by_user',
    'staff_assistant_messages.requested_model',
    'staff_assistant_messages.gateway_model',
    'staff_assistant_messages.ttfb_ms',
    'staff_assistant_messages.error_code',
    'staff_assistant_feedback.report_kind',
    'staff_assistant_unanswered.error_code',
    'staff_assistant_unanswered.error_detail',
    'staff_assistant_unanswered.routed_department',
    'staff_assistant_knowledge_base.created_by',
    'staff_assistant_knowledge_base.approved_by',
    'staff_assistant_knowledge_base.expires_at',
    'staff_assistant_preferences.web_push_enabled',
    'staff_assistant_preferences.web_push_morning_brief_topic',
    'staff_assistant_preferences.web_push_taught_updates_topic',
    'staff_assistant_preferences.voice_disclosure_acknowledged_at'
  ];
  v_required_views constant text[] := ARRAY[
    'zoe_ro.finance_treasury_cash_position',
    'zoe_ro.finance_receivables_and_payables',
    'zoe_ro.finance_requisitions_summary',
    'zoe_ro.finance_budget_cycles',
    'zoe_ro.operations_daily_collection_coverage',
    'zoe_ro.operations_rent_plans_by_stage',
    'zoe_ro.calling_daily_attempts_summary',
    'zoe_ro.calling_pipeline_awareness_summary',
    'zoe_ro.hr_department_headcount',
    'zoe_ro.hr_contracts_overview',
    'zoe_ro.agents_daily_collections_by_region',
    'zoe_ro.agents_house_listings_summary',
    'zoe_ro.supporters_portfolios_summary',
    'zoe_ro.supporters_promissory_notes_summary',
    'zoe_ro.tenants_rent_plans_by_city',
    'zoe_ro.tenants_arrears_by_city',
    'zoe_ro.landlords_registry_by_district',
    'zoe_ro.landlords_payouts_summary',
    'zoe_ro.calling_my_space_officer_daily',
    'zoe_ro.tenants_directory_by_stage_and_location',
    'zoe_ro.operations_desk_turnaround_summary',
    'zoe_ro.tenants_first_seven_days_cohort'
  ];
  v_required_functions constant text[] := ARRAY[
    'staff_assistant_has_access',
    'staff_assistant_get_config',
    'staff_assistant_can_user_read_report',
    'staff_assistant_save_draft',
    'staff_assistant_consume_draft',
    'staff_assistant_check_question_rate_limit',
    'staff_assistant_check_email_budget',
    'staff_assistant_hide_my_history',
    'staff_assistant_error_summary',
    'staff_assistant_real_use_dashboard',
    'staff_assistant_upsert_project',
    'staff_assistant_list_projects',
    'staff_assistant_delete_project',
    'staff_assistant_department_teaching_queue',
    'staff_assistant_teach_from_review_queue',
    'staff_assistant_role_goals_and_measures',
    'staff_assistant_can_send_web_push',
    'staff_assistant_update_push_and_voice_prefs',
    'assistant_staff_get_glossary',
    'assistant_staff_data_catalog',
    'assistant_staff_get_data_catalog',
    'assistant_staff_run_query',
    'assistant_staff_my_work_summary',
    'assistant_staff_team_work_summary',
    'assistant_staff_search_knowledge_base',
    'assistant_staff_my_taught_updates',
    'assistant_staff_my_reminders_and_schedules',
    'assistant_staff_my_calls',
    'assistant_staff_tops_rent_requests_by_stage',
    'assistant_staff_tops_time_on_desk',
    'assistant_staff_tops_find_tenant',
    'assistant_staff_tops_awareness_calls',
    'assistant_staff_lops_verification_queue',
    'assistant_staff_aops_subagent_teams',
    'assistant_staff_pops_returns_due',
    'assistant_staff_pops_topups_and_withdrawals_waiting',
    'assistant_staff_fops_disbursements',
    'assistant_staff_fops_merchant_cashouts',
    'assistant_staff_insight_desk_wait_times',
    'assistant_staff_insight_collection_coverage_trends',
    'assistant_staff_insight_calling_reach_and_themes',
    'assistant_staff_insight_payout_delays',
    'assistant_staff_insight_zoe_feedback_themes'
  ];
  v_missing_tables text[] := ARRAY[]::text[];
  v_missing_columns text[] := ARRAY[]::text[];
  v_missing_views text[] := ARRAY[]::text[];
  v_missing_functions text[] := ARRAY[]::text[];
  v_missing_all text[] := ARRAY[]::text[];
  v_item text;
  v_tbl text;
  v_col text;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required for staff_assistant_health.'
      USING ERRCODE = '42501';
  END IF;

  FOREACH v_item IN ARRAY v_required_tables LOOP
    IF to_regclass('public.' || v_item) IS NULL THEN
      v_missing_tables := array_append(v_missing_tables, v_item);
      v_missing_all := array_append(v_missing_all, 'table:' || v_item);
    END IF;
  END LOOP;

  FOREACH v_item IN ARRAY v_required_columns LOOP
    v_tbl := split_part(v_item, '.', 1);
    v_col := split_part(v_item, '.', 2);
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns ic
       WHERE ic.table_schema = 'public'
         AND ic.table_name = v_tbl
         AND ic.column_name = v_col
    ) THEN
      v_missing_columns := array_append(v_missing_columns, v_item);
      v_missing_all := array_append(v_missing_all, 'column:' || v_item);
    END IF;
  END LOOP;

  FOREACH v_item IN ARRAY v_required_views LOOP
    IF to_regclass(v_item) IS NULL THEN
      v_missing_views := array_append(v_missing_views, v_item);
      v_missing_all := array_append(v_missing_all, 'view:' || v_item);
    END IF;
  END LOOP;

  FOREACH v_item IN ARRAY v_required_functions LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = v_item
    ) THEN
      v_missing_functions := array_append(v_missing_functions, v_item);
      v_missing_all := array_append(v_missing_all, 'function:' || v_item);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', (COALESCE(array_length(v_missing_all, 1), 0) = 0),
    'status', CASE
      WHEN COALESCE(array_length(v_missing_all, 1), 0) = 0 THEN 'ok'
      ELSE 'zoe_database_behind'
    END,
    'missing_count', COALESCE(array_length(v_missing_all, 1), 0),
    'missing_objects', to_jsonb(v_missing_all),
    'missing_tables', to_jsonb(v_missing_tables),
    'missing_columns', to_jsonb(v_missing_columns),
    'missing_views', to_jsonb(v_missing_views),
    'missing_functions', to_jsonb(v_missing_functions),
    'checked_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_health() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_health() TO authenticated;

COMMIT;
