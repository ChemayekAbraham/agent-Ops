-- =============================================================================
-- Zoe (My Space Staff Assistant) — Prompt 1: Reliability, Model Pinning,
-- Guaranteed Error Codes, Migration History Alignment & Real-Use Dashboard
-- Version: 20261031120000 (unique across supabase/migrations/ and schema_migrations)
-- =============================================================================

-- 1. Record renamed Zoe migration versions in supabase_migrations.schema_migrations
--    without re-running already-applied objects, and restore 20261030100000 to
--    tlb_tenants_multi_and_pdf_export_audit where applicable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'schema_migrations'
  ) THEN
    UPDATE supabase_migrations.schema_migrations
    SET name = 'tlb_tenants_multi_and_pdf_export_audit'
    WHERE version = '20261030100000'
      AND name = 'staff_assistant_parity_health_and_error_codes';

    INSERT INTO supabase_migrations.schema_migrations (version, name)
    VALUES
      ('20261025230000', 'staff_assistant_foundation'),
      ('20261025233000', 'staff_assistant_email_recipients'),
      ('20261026000000', 'staff_assistant_read_tools_batch1'),
      ('20261026130000', 'staff_assistant_read_tools_batch2'),
      ('20261026150000', 'staff_assistant_crm_review_and_usage'),
      ('20261026160000', 'staff_assistant_actions_schedules_and_brief'),
      ('20261027100500', 'staff_assistant_security_hardening'),
      ('20261027130000', 'staff_assistant_prompt3_coverage_and_learning'),
      ('20261027150500', 'staff_assistant_prompt4_advisor_insights_and_ideas'),
      ('20261028110500', 'staff_assistant_prompt1_live_fixes'),
      ('20261028150500', 'staff_assistant_prompt2_brain_memory_glossary'),
      ('20261028180500', 'staff_assistant_prompt3_analyst_lane_zoe_ro'),
      ('20261029180500', 'staff_assistant_prompt4_consultant_and_proactive'),
      ('20261030100500', 'staff_assistant_parity_health_and_error_codes'),
      ('20261030140500', 'staff_assistant_prompt4_learning_kb_and_starters'),
      ('20261031120000', 'staff_assistant_prompt1_reliability_and_real_use_dashboard')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END
$$;

-- 2. Add model-pinning, TTFB, cost, error-code, and Analyst/research columns
--    to staff_assistant_messages and staff_assistant_learning_log.
ALTER TABLE public.staff_assistant_messages
  ADD COLUMN IF NOT EXISTS requested_model text,
  ADD COLUMN IF NOT EXISTS gateway_model text,
  ADD COLUMN IF NOT EXISTS ttfb_ms integer,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS cost_usd numeric(10,6),
  ADD COLUMN IF NOT EXISTS analyst_used boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS research_used boolean NOT NULL DEFAULT false;

ALTER TABLE public.staff_assistant_learning_log
  ADD COLUMN IF NOT EXISTS requested_model text,
  ADD COLUMN IF NOT EXISTS gateway_model text,
  ADD COLUMN IF NOT EXISTS ttfb_ms integer,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS analyst_used boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS research_used boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_staff_assistant_messages_created_role
  ON public.staff_assistant_messages (created_at DESC, role);

-- Backfill gateway_model and requested_model on historical assistant messages
UPDATE public.staff_assistant_messages
SET
  gateway_model = COALESCE(gateway_model, model),
  requested_model = COALESCE(
    requested_model,
    CASE
      WHEN model = 'google/gemini-3.8-flash' THEN 'google/gemini-3-flash-preview'
      ELSE model
    END
  ),
  ttfb_ms = COALESCE(ttfb_ms, latency_ms),
  analyst_used = (analyst_used OR ('run_analyst_query' = ANY(tools_called))),
  research_used = (
    research_used
    OR ('search_web' = ANY(tools_called))
    OR ('read_web_page' = ANY(tools_called))
  )
WHERE role = 'assistant'
  AND (gateway_model IS NULL OR requested_model IS NULL OR ttfb_ms IS NULL);

-- 3. Guarantee non-null error_code on every row in staff_assistant_unanswered
UPDATE public.staff_assistant_unanswered
SET error_code = CASE reason
  WHEN 'error' THEN 'ERR_TURN_FAILED'
  WHEN 'blocked' THEN 'ERR_GUARD_OUTPUT_BLOCKED'
  WHEN 'out_of_scope' THEN 'ERR_OUT_OF_SCOPE'
  WHEN 'not_staff' THEN 'ERR_ROLE_RESTRICTED'
  WHEN 'missing_tool' THEN 'ERR_MISSING_TOOL'
  WHEN 'unmatched' THEN 'ERR_UNMATCHED_INTENT'
  ELSE 'ERR_UNSPECIFIED_FAILURE'
END
WHERE error_code IS NULL OR btrim(error_code) = '';

CREATE OR REPLACE FUNCTION public.staff_assistant_unanswered_ensure_error_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.error_code IS NULL OR btrim(NEW.error_code) = '' THEN
    NEW.error_code := CASE NEW.reason
      WHEN 'error' THEN 'ERR_TURN_FAILED'
      WHEN 'blocked' THEN 'ERR_GUARD_OUTPUT_BLOCKED'
      WHEN 'out_of_scope' THEN 'ERR_OUT_OF_SCOPE'
      WHEN 'not_staff' THEN 'ERR_ROLE_RESTRICTED'
      WHEN 'missing_tool' THEN 'ERR_MISSING_TOOL'
      WHEN 'unmatched' THEN 'ERR_UNMATCHED_INTENT'
      ELSE 'ERR_UNSPECIFIED_FAILURE'
    END;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_unanswered_ensure_error_code() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_unanswered_ensure_error_code() TO authenticated;

DROP TRIGGER IF EXISTS trg_staff_assistant_unanswered_ensure_error_code
  ON public.staff_assistant_unanswered;

CREATE TRIGGER trg_staff_assistant_unanswered_ensure_error_code
  BEFORE INSERT OR UPDATE ON public.staff_assistant_unanswered
  FOR EACH ROW
  EXECUTE FUNCTION public.staff_assistant_unanswered_ensure_error_code();

-- Backfill error_code on historical error/blocked assistant messages from unanswered log
UPDATE public.staff_assistant_messages m
SET error_code = COALESCE(
  (
    SELECT u.error_code
    FROM public.staff_assistant_unanswered u
    WHERE u.conversation_id = m.conversation_id
      AND u.error_code IS NOT NULL
      AND ABS(EXTRACT(EPOCH FROM (u.created_at - m.created_at))) <= 15
    ORDER BY ABS(EXTRACT(EPOCH FROM (u.created_at - m.created_at))) ASC
    LIMIT 1
  ),
  CASE m.outcome
    WHEN 'error' THEN 'ERR_TURN_FAILED'
    WHEN 'blocked' THEN 'ERR_GUARD_OUTPUT_BLOCKED'
    WHEN 'out_of_scope' THEN 'ERR_OUT_OF_SCOPE'
    WHEN 'not_staff' THEN 'ERR_ROLE_RESTRICTED'
    WHEN 'missing_tool' THEN 'ERR_MISSING_TOOL'
    WHEN 'unmatched' THEN 'ERR_UNMATCHED_INTENT'
    ELSE NULL
  END
)
WHERE m.role = 'assistant'
  AND m.outcome IN ('error', 'blocked', 'out_of_scope', 'not_staff', 'missing_tool', 'unmatched')
  AND m.error_code IS NULL;

-- 4. Manager-Only Real-Use Dashboard RPC (counts and aggregates only, zero question text)
CREATE OR REPLACE FUNCTION public.staff_assistant_real_use_dashboard(
  p_days integer DEFAULT 14
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 14), 1), 90);
  v_since timestamptz := (
    ((now() AT TIME ZONE 'Africa/Kampala')::date - (LEAST(GREATEST(COALESCE(p_days, 14), 1), 90) - 1))::timestamp
    AT TIME ZONE 'Africa/Kampala'
  );
  v_summary jsonb;
  v_by_day_and_role jsonb;
  v_errors_by_code jsonb;
  v_models_used jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_crm_can_review() THEN
    RAISE EXCEPTION 'Not authorized: manager or CRM review role required for staff_assistant_real_use_dashboard.'
      USING ERRCODE = '42501';
  END IF;

  -- Overall summary across the window (assistant turns represent completed/attempted questions)
  WITH assistant_turns AS (
    SELECT
      m.id,
      m.user_id,
      (m.created_at AT TIME ZONE 'Africa/Kampala')::date AS day_kampala,
      COALESCE(m.outcome, 'answered') AS outcome,
      COALESCE(m.ttfb_ms, m.latency_ms) AS ttfb_ms,
      m.latency_ms,
      COALESCE(m.requested_model, m.model, 'unknown') AS requested_model,
      COALESCE(m.gateway_model, m.model, 'unknown') AS gateway_model,
      COALESCE(m.cost_usd, 0)::numeric AS cost_usd,
      (m.analyst_used OR ('run_analyst_query' = ANY(m.tools_called))) AS is_analyst,
      (
        m.research_used
        OR ('search_web' = ANY(m.tools_called))
        OR ('read_web_page' = ANY(m.tools_called))
      ) AS is_research
    FROM public.staff_assistant_messages m
    WHERE m.role = 'assistant'
      AND m.created_at >= v_since
  ),
  feedback_window AS (
    SELECT
      f.rating,
      (f.created_at AT TIME ZONE 'Africa/Kampala')::date AS day_kampala,
      f.user_id
    FROM public.staff_assistant_feedback f
    WHERE f.created_at >= v_since
  )
  SELECT jsonb_build_object(
    'active_users', COALESCE((SELECT count(DISTINCT user_id) FROM assistant_turns), 0),
    'questions', COALESCE((SELECT count(*) FROM assistant_turns), 0),
    'answered_count', COALESCE((SELECT count(*) FROM assistant_turns WHERE outcome = 'answered'), 0),
    'answered_pct', CASE
      WHEN COALESCE((SELECT count(*) FROM assistant_turns), 0) > 0 THEN
        ROUND(
          (
            (SELECT count(*)::numeric FROM assistant_turns WHERE outcome = 'answered')
            * 100.0
            / (SELECT count(*)::numeric FROM assistant_turns)
          ),
          1
        )
      ELSE 0.0
    END,
    'refusals', COALESCE(
      (SELECT count(*) FROM assistant_turns WHERE outcome IN ('blocked', 'out_of_scope', 'not_staff')),
      0
    ),
    'errors', COALESCE(
      (SELECT count(*) FROM assistant_turns WHERE outcome IN ('error', 'missing_tool', 'unmatched')),
      0
    ),
    'median_ttfb_ms', (
      SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfb_ms))::integer
      FROM assistant_turns
      WHERE ttfb_ms IS NOT NULL AND ttfb_ms > 0
    ),
    'p95_ttfb_ms', (
      SELECT ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfb_ms))::integer
      FROM assistant_turns
      WHERE ttfb_ms IS NOT NULL AND ttfb_ms > 0
    ),
    'total_cost_usd', COALESCE(
      (SELECT ROUND(SUM(cost_usd), 6) FROM assistant_turns),
      0
    ),
    'thumbs_up', COALESCE((SELECT count(*) FROM feedback_window WHERE rating = 'up'), 0),
    'thumbs_down', COALESCE((SELECT count(*) FROM feedback_window WHERE rating = 'down'), 0),
    'analyst_use_count', COALESCE((SELECT count(*) FROM assistant_turns WHERE is_analyst), 0),
    'research_use_count', COALESCE((SELECT count(*) FROM assistant_turns WHERE is_research), 0)
  )
  INTO v_summary;

  -- Per day and role breakdown (zero question text, zero user PII)
  WITH user_primary_role AS (
    SELECT
      ur.user_id,
      COALESCE(
        (
          SELECT r.role::text
          FROM public.user_roles r
          WHERE r.user_id = ur.user_id
            AND COALESCE(r.enabled, true) = true
          ORDER BY CASE r.role::text
            WHEN 'ceo' THEN 1
            WHEN 'cfo' THEN 2
            WHEN 'coo' THEN 3
            WHEN 'cto' THEN 4
            WHEN 'super_admin' THEN 5
            WHEN 'crm' THEN 6
            WHEN 'hr' THEN 7
            WHEN 'financial_ops' THEN 8
            WHEN 'tenant_ops' THEN 9
            WHEN 'landlord_ops' THEN 10
            WHEN 'agent_ops' THEN 11
            WHEN 'partner_ops' THEN 12
            WHEN 'manager' THEN 13
            ELSE 20
          END
          LIMIT 1
        ),
        'employee'
      ) AS role_name
    FROM (
      SELECT DISTINCT user_id
      FROM public.staff_assistant_messages
      WHERE created_at >= v_since
    ) ur
  ),
  turns_with_role AS (
    SELECT
      (m.created_at AT TIME ZONE 'Africa/Kampala')::date AS day_kampala,
      COALESCE(upr.role_name, 'employee') AS role_name,
      m.user_id,
      COALESCE(m.outcome, 'answered') AS outcome,
      COALESCE(m.ttfb_ms, m.latency_ms) AS ttfb_ms,
      COALESCE(m.gateway_model, m.model, 'unknown') AS gateway_model,
      COALESCE(m.requested_model, m.model, 'unknown') AS requested_model,
      COALESCE(m.cost_usd, 0)::numeric AS cost_usd,
      (m.analyst_used OR ('run_analyst_query' = ANY(m.tools_called))) AS is_analyst,
      (
        m.research_used
        OR ('search_web' = ANY(m.tools_called))
        OR ('read_web_page' = ANY(m.tools_called))
      ) AS is_research
    FROM public.staff_assistant_messages m
    LEFT JOIN user_primary_role upr ON upr.user_id = m.user_id
    WHERE m.role = 'assistant'
      AND m.created_at >= v_since
  ),
  feedback_by_day_role AS (
    SELECT
      (f.created_at AT TIME ZONE 'Africa/Kampala')::date AS day_kampala,
      COALESCE(upr.role_name, 'employee') AS role_name,
      count(*) FILTER (WHERE f.rating = 'up') AS thumbs_up,
      count(*) FILTER (WHERE f.rating = 'down') AS thumbs_down
    FROM public.staff_assistant_feedback f
    LEFT JOIN user_primary_role upr ON upr.user_id = f.user_id
    WHERE f.created_at >= v_since
    GROUP BY 1, 2
  ),
  grouped AS (
    SELECT
      t.day_kampala,
      t.role_name,
      count(DISTINCT t.user_id) AS active_users,
      count(*) AS questions,
      count(*) FILTER (WHERE t.outcome = 'answered') AS answered_count,
      ROUND(
        (count(*) FILTER (WHERE t.outcome = 'answered'))::numeric * 100.0
        / NULLIF(count(*)::numeric, 0),
        1
      ) AS answered_pct,
      count(*) FILTER (WHERE t.outcome IN ('blocked', 'out_of_scope', 'not_staff')) AS refusals,
      count(*) FILTER (WHERE t.outcome IN ('error', 'missing_tool', 'unmatched')) AS errors,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.ttfb_ms) FILTER (WHERE t.ttfb_ms IS NOT NULL AND t.ttfb_ms > 0))::integer AS median_ttfb_ms,
      ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY t.ttfb_ms) FILTER (WHERE t.ttfb_ms IS NOT NULL AND t.ttfb_ms > 0))::integer AS p95_ttfb_ms,
      mode() WITHIN GROUP (ORDER BY t.gateway_model) AS model_used,
      mode() WITHIN GROUP (ORDER BY t.requested_model) AS requested_model,
      ROUND(SUM(t.cost_usd), 6) AS cost_usd,
      COALESCE(fb.thumbs_up, 0) AS thumbs_up,
      COALESCE(fb.thumbs_down, 0) AS thumbs_down,
      count(*) FILTER (WHERE t.is_analyst) AS analyst_use_count,
      count(*) FILTER (WHERE t.is_research) AS research_use_count
    FROM turns_with_role t
    LEFT JOIN feedback_by_day_role fb
      ON fb.day_kampala = t.day_kampala AND fb.role_name = t.role_name
    GROUP BY t.day_kampala, t.role_name, fb.thumbs_up, fb.thumbs_down
    ORDER BY t.day_kampala DESC, questions DESC, t.role_name ASC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(grouped)), '[]'::jsonb)
  INTO v_by_day_and_role
  FROM grouped;

  -- Errors by code across the window (zero question text)
  WITH err_rows AS (
    SELECT
      COALESCE(NULLIF(btrim(u.error_code), ''), 'ERR_TURN_FAILED') AS error_code,
      u.reason,
      count(*) AS error_count,
      count(DISTINCT u.user_id) AS affected_users,
      max(u.created_at) AS last_seen_at
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_since
    GROUP BY 1, 2
    ORDER BY error_count DESC, last_seen_at DESC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(err_rows)), '[]'::jsonb)
  INTO v_errors_by_code
  FROM err_rows;

  -- Models breakdown (requested vs gateway returned)
  WITH model_rows AS (
    SELECT
      COALESCE(m.requested_model, m.model, 'unknown') AS requested_model,
      COALESCE(m.gateway_model, m.model, 'unknown') AS gateway_model,
      count(*) AS turn_count,
      count(*) FILTER (WHERE m.outcome = 'answered') AS answered_count,
      count(*) FILTER (WHERE m.outcome = 'error') AS error_count,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(m.ttfb_ms, m.latency_ms)) FILTER (WHERE COALESCE(m.ttfb_ms, m.latency_ms) > 0))::integer AS median_ttfb_ms,
      ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE(m.ttfb_ms, m.latency_ms)) FILTER (WHERE COALESCE(m.ttfb_ms, m.latency_ms) > 0))::integer AS p95_ttfb_ms,
      ROUND(SUM(COALESCE(m.cost_usd, 0)), 6) AS total_cost_usd
    FROM public.staff_assistant_messages m
    WHERE m.role = 'assistant'
      AND m.created_at >= v_since
    GROUP BY 1, 2
    ORDER BY turn_count DESC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(model_rows)), '[]'::jsonb)
  INTO v_models_used
  FROM model_rows;

  RETURN jsonb_build_object(
    'window_days', v_days,
    'from_date', ((now() AT TIME ZONE 'Africa/Kampala')::date - (v_days - 1))::text,
    'to_date', ((now() AT TIME ZONE 'Africa/Kampala')::date)::text,
    'summary', COALESCE(v_summary, '{}'::jsonb),
    'by_day_and_role', COALESCE(v_by_day_and_role, '[]'::jsonb),
    'errors_by_code', COALESCE(v_errors_by_code, '[]'::jsonb),
    'models_used', COALESCE(v_models_used, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_real_use_dashboard(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_real_use_dashboard(integer) TO authenticated;
