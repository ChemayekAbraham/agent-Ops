-- =============================================================================
-- Migration: 20261028110000_staff_assistant_prompt1_live_fixes.sql
-- Purpose:   Prompt 1 live failure fixes for Zoe (My Space Staff Assistant):
--              1. Reconcile `staff_assistant_conversations` and `staff_assistant_messages`
--                 columns (`created_at`, `last_message_at`, `updated_at`, `hidden_by_user`,
--                 `hidden_at`, `conversation_summary`) so conversation and message logging
--                 never fails regardless of migration apply order.
--              2. `assistant_staff_tops_first_seven_summary`: include `uncollected`
--                 (`expected - collected`) in `data` so Zoe can state the First 7 Days
--                 shortfall without tripping the deterministic number guard.
--              3. `assistant_staff_tops_arrears_ageing`: include `total_arrears_ugx` and
--                 `total_plans` across all buckets in `data.summary` so Zoe can state the
--                 overall arrears total alongside the bucket breakdown.
--              4. `assistant_staff_cfo_receivables_and_payables`: set a 25s statement
--                 timeout inside the SECURITY DEFINER function and handle forecast query
--                 cancellation gracefully so PostgREST's 8s timeout does not abort the tool.
--              5. `assistant_staff_hr_calling_detailed_report`: compute an exact top-level
--                 `summary` (`total_calls`, `answered_calls`, `unanswered_calls`, `by_staff`,
--                 `by_source`) across the full date window and cap `detailed_rows` at 50
--                 compact rows so monthly calling reports stay fast and under 16 KB.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Schema reconciliation for conversation & message persistence
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_conversations
  ADD COLUMN IF NOT EXISTS hidden_by_user boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_message_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS conversation_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.staff_assistant_conversations
   SET created_at = COALESCE(started_at, created_at, now()),
       last_message_at = COALESCE(last_active_at, started_at, last_message_at, now()),
       updated_at = COALESCE(last_active_at, started_at, updated_at, now());

ALTER TABLE public.staff_assistant_messages
  ADD COLUMN IF NOT EXISTS hidden_by_user boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_staff_assistant_conversations_user_visible
  ON public.staff_assistant_conversations (user_id, last_message_at DESC)
  WHERE hidden_by_user = false;

CREATE INDEX IF NOT EXISTS idx_staff_assistant_messages_user_visible
  ON public.staff_assistant_messages (user_id, created_at DESC)
  WHERE hidden_by_user = false;

-- -----------------------------------------------------------------------------
-- 2. Q10. assistant_staff_tops_first_seven_summary(p_from, p_to, p_frequency)
--    Adds `uncollected` (`expected - collected`) to `data` so shortfall figures
--    are explicitly present in the tool output.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_first_seven_summary(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_frequency text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := coalesce(p_to, v_today);
  v_from date := coalesce(p_from, v_to - 30);
  v_allow_phones boolean;
  v_raw jsonb;
  v_clean jsonb;
  v_expected numeric;
  v_collected numeric;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._am_staff_ok()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Tenant Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('tenant_ops');
  v_raw := public.am_new_tenant_first7_summary_v2(v_from, v_to, p_frequency, NULL);
  v_clean := coalesce(public.staff_assistant_sanitize_jsonb(v_raw, v_allow_phones, 200), '{}'::jsonb);

  v_expected := coalesce((v_clean ->> 'expected')::numeric, 0);
  v_collected := coalesce((v_clean ->> 'collected')::numeric, 0);
  v_clean := v_clean || jsonb_build_object(
    'uncollected', GREATEST(v_expected - v_collected, 0)
  );

  RETURN jsonb_build_object(
    'source', 'am_new_tenant_first7_summary_v2',
    'period', jsonb_build_object('from', v_from, 'to', v_to, 'frequency', p_frequency),
    'row_limit', 200,
    'data', v_clean,
    'rows', coalesce(v_clean -> 'per_day', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_first_seven_summary(date, date, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_first_seven_summary(date, date, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Q11. assistant_staff_tops_arrears_ageing(p_as_at, p_bucket, p_limit, p_offset, p_dir)
--    Adds `total_arrears_ugx` and `total_plans` across buckets to `data.summary`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_arrears_ageing(
  p_as_at date DEFAULT NULL,
  p_bucket text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_dir text DEFAULT 'desc'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_as_at date := coalesce(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
  v_offset integer := GREATEST(coalesce(p_offset, 0), 0);
  v_allow_phones boolean;
  v_raw jsonb;
  v_clean jsonb;
  v_summary jsonb;
  v_total_arrears numeric := 0;
  v_total_plans integer := 0;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public._am_staff_ok()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['tenant_ops','operations','coo','ceo','cfo','super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Tenant Ops access required'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('tenant_ops');
  v_raw := public.tops_arrears_ageing_amclock(v_as_at, p_bucket, v_limit, v_offset, p_dir);
  v_clean := coalesce(public.staff_assistant_sanitize_jsonb(v_raw, v_allow_phones, 200), '{}'::jsonb);
  v_summary := coalesce(v_clean -> 'summary', '{}'::jsonb);

  IF jsonb_typeof(v_summary) = 'object' THEN
    SELECT
      coalesce(sum(coalesce((val ->> 'arrears_ugx')::numeric, 0)), 0),
      coalesce(sum(coalesce((val ->> 'count')::integer, 0)), 0)::integer
    INTO v_total_arrears, v_total_plans
    FROM jsonb_each(v_summary) AS e(key, val)
    WHERE jsonb_typeof(val) = 'object';

    v_summary := v_summary || jsonb_build_object(
      'total_arrears_ugx', v_total_arrears,
      'total_plans', v_total_plans
    );
    v_clean := jsonb_set(v_clean, '{summary}', v_summary, true);
  END IF;

  RETURN jsonb_build_object(
    'source', 'tops_arrears_ageing_amclock',
    'period', jsonb_build_object('as_of', v_as_at, 'bucket', p_bucket),
    'row_limit', v_limit,
    'total_arrears_ugx', v_total_arrears,
    'total_plans', v_total_plans,
    'data', v_clean,
    'rows', coalesce(v_clean -> 'rows', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_arrears_ageing(date, text, integer, integer, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_arrears_ageing(date, text, integer, integer, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. F3 (Q34). assistant_staff_cfo_receivables_and_payables(p_granularity, p_periods, p_as_at)
--    Sets a 25s statement timeout inside the SECURITY DEFINER function and handles
--    forecast timeouts gracefully so Receivables and Payables totals always return.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_cfo_receivables_and_payables(
  p_granularity text DEFAULT 'week',
  p_periods integer DEFAULT 4,
  p_as_at date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '25s'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := coalesce(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_gran text := CASE
    WHEN lower(btrim(coalesce(p_granularity, ''))) IN ('day', 'week', 'month', 'quarter', 'year')
      THEN lower(btrim(p_granularity))
    ELSE 'week'
  END;
  v_periods integer := LEAST(GREATEST(coalesce(p_periods, 4), 1), 24);
  v_receivables jsonb;
  v_payables jsonb;
  v_forecast jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_finance_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['cfo', 'ceo', 'coo', 'manager', 'financial_ops', 'cto', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for receivables and payables reports.'
      USING ERRCODE = '42501';
  END IF;

  v_receivables := public.get_receivables_total();
  v_payables := public.get_payables_total();

  BEGIN
    v_forecast := public.get_payables_predictive_forecast(v_gran, v_periods, v_today);
  EXCEPTION
    WHEN OTHERS THEN
      v_forecast := jsonb_build_object(
        'as_at', v_today,
        'granularity', v_gran,
        'status', 'unavailable',
        'note', 'Predictive forecast timed out or is temporarily unavailable; authoritative Receivables and Payables totals are shown above.'
      );
  END;

  RETURN jsonb_build_object(
    'source', 'get_receivables_total + get_payables_total + get_payables_predictive_forecast (Receivables & Payables)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'granularity', v_gran,
      'periods', v_periods,
      'timezone', 'Africa/Kampala'
    ),
    'receivables', coalesce(v_receivables, '{}'::jsonb),
    'payables', coalesce(v_payables, '{}'::jsonb),
    'payables_forecast', coalesce(v_forecast, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_cfo_receivables_and_payables(text, integer, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_cfo_receivables_and_payables(text, integer, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. H1 (Q39). assistant_staff_hr_calling_detailed_report(p_from, p_to)
--    Pre-aggregates exact totals and per-officer breakdown across the full date
--    window and caps `detailed_rows` at 50 compact rows so monthly reports stay
--    under 16 KB and never cut off `weekly_all_calls_summary`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_hr_calling_detailed_report(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_from date := LEAST(coalesce(p_from, v_to - 6), v_to);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_is_calling_member boolean := v_uid IN (
    '5295252d-f477-42a9-92f5-af56e503e33d'::uuid, -- Jane
    'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid, -- Winnie
    'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid, -- Hanisha
    'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid  -- Mark Bwayo
  );
  v_allow_phones boolean;
  v_total_calls integer := 0;
  v_answered_calls integer := 0;
  v_unanswered_calls integer := 0;
  v_by_staff jsonb := '[]'::jsonb;
  v_by_source jsonb := '[]'::jsonb;
  v_detailed jsonb := '[]'::jsonb;
  v_weekly_summary jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       v_is_calling_member
       OR public.hr_is_admin()
       OR public._has_enabled_role(
         v_uid,
         ARRAY['hr', 'coo', 'cfo', 'ceo', 'manager', 'operations', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for staff calling detailed reports.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('calling');

  WITH all_calls AS (
    SELECT *
      FROM public.staff_calling_detailed_report(v_start, v_end)
  ),
  totals AS (
    SELECT
      count(*)::integer AS total_calls,
      count(*) FILTER (WHERE coalesce(answered, false) = true)::integer AS answered_calls,
      count(*) FILTER (WHERE coalesce(answered, false) = false)::integer AS unanswered_calls
    FROM all_calls
  ),
  staff_rollup AS (
    SELECT
      coalesce(nullif(btrim(staff_name), ''), 'Unassigned') AS staff_name,
      count(*)::integer AS total_calls,
      count(*) FILTER (WHERE coalesce(answered, false) = true)::integer AS answered_calls,
      count(*) FILTER (WHERE coalesce(answered, false) = false)::integer AS unanswered_calls
    FROM all_calls
    GROUP BY coalesce(nullif(btrim(staff_name), ''), 'Unassigned')
    ORDER BY count(*) DESC, staff_name ASC
  ),
  source_rollup AS (
    SELECT
      coalesce(nullif(btrim(source), ''), 'Unknown') AS source,
      count(*)::integer AS total_calls,
      count(*) FILTER (WHERE coalesce(answered, false) = true)::integer AS answered_calls,
      count(*) FILTER (WHERE coalesce(answered, false) = false)::integer AS unanswered_calls
    FROM all_calls
    GROUP BY coalesce(nullif(btrim(source), ''), 'Unknown')
    ORDER BY count(*) DESC, source ASC
  ),
  sample_rows AS (
    SELECT
      called_at,
      staff_name,
      source,
      role,
      person_name,
      person_phone,
      answered,
      outcome,
      left(coalesce(feedback, ''), 160) AS feedback
    FROM all_calls
    ORDER BY called_at DESC NULLS LAST
    LIMIT 50
  )
  SELECT
    coalesce((SELECT total_calls FROM totals), 0),
    coalesce((SELECT answered_calls FROM totals), 0),
    coalesce((SELECT unanswered_calls FROM totals), 0),
    coalesce((SELECT jsonb_agg(to_jsonb(sr)) FROM staff_rollup sr), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(src)) FROM source_rollup src), '[]'::jsonb),
    coalesce(
      (
        SELECT jsonb_agg(
          public.staff_assistant_sanitize_jsonb(
            to_jsonb(r),
            v_allow_phones,
            50
          )
        )
        FROM sample_rows r
      ),
      '[]'::jsonb
    )
  INTO
    v_total_calls,
    v_answered_calls,
    v_unanswered_calls,
    v_by_staff,
    v_by_source,
    v_detailed;

  SELECT coalesce(
    jsonb_agg(
      to_jsonb(w) - 'caller_id'
    ),
    '[]'::jsonb
  )
  INTO v_weekly_summary
  FROM (
    SELECT *
      FROM public.cc_weekly_all_calls_report(v_start, v_end)
     LIMIT 200
  ) w;

  RETURN jsonb_build_object(
    'source', 'staff_calling_detailed_report + cc_weekly_all_calls_report (Staff Calling & Pipeline Feedback Report)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'summary', jsonb_build_object(
      'total_calls', v_total_calls,
      'answered_calls', v_answered_calls,
      'unanswered_calls', v_unanswered_calls,
      'by_staff', v_by_staff,
      'by_source', v_by_source
    ),
    'row_count', v_total_calls,
    'detailed_row_count', v_total_calls,
    'rows', v_by_staff,
    'detailed_rows', v_detailed,
    'weekly_all_calls_summary', v_weekly_summary
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_hr_calling_detailed_report(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_hr_calling_detailed_report(date, date) TO authenticated;

COMMIT;
