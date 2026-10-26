-- =============================================================================
-- Migration: 20261026130000_staff_assistant_read_tools_batch2.sql
-- Purpose:   Zoe (My Space AI Assistant) read-only tool RPCs — Batch 2:
--              - Group D: Agent Ops (Questions 23–27, 5 tools)
--              - Group E: Partner Ops & PSO (Questions 28–31, 4 tools)
--              - Group F: CFO & Financial Ops (Questions 32–36, 6 tools)
--              - Group G: COO, CEO & Managers (Questions 37–38, 2 tools)
--              - Group H: HR & Calling Team (Questions 39–40, 3 tools)
--
-- Safety & Invariants:
--   1. Every assistant_staff_* function is STABLE, SECURITY DEFINER,
--      and SET search_path = public.
--   2. Zero user/agent/tenant/account/owner identity parameters; caller
--      identity is always resolved from auth.uid().
--   3. Every function begins with public.staff_assistant_has_access() plus
--      can_view_finance_reports / can_view_staff_reports and the department
--      role check, raising ERRCODE = '42501' if not allowed.
--   4. Every figure comes from the official existing report function without
--      recalculating money or counts. Platform cash comes ONLY from
--      public.get_treasury_cash_position().
--   5. Returns at most 200 rows plus explicit 'source' and 'period' fields.
--   6. Masks phone numbers and national IDs for roles that do not see them
--      on their normal screens via staff_assistant_sanitize_jsonb().
--   7. Grants EXECUTE to authenticated only (revoked from PUBLIC, anon, service_role).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Expand PII visibility helper for Batch 2 department scopes
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.staff_assistant_can_view_pii(
  p_scope text DEFAULT 'ops'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false
    WHEN p_scope = 'self' THEN true
    WHEN p_scope = 'tenant_ops' THEN
      public._has_enabled_role(
        auth.uid(),
        ARRAY['tenant_ops', 'operations', 'coo', 'super_admin']
      )
    WHEN p_scope = 'landlord_ops' THEN
      public._has_enabled_role(
        auth.uid(),
        ARRAY['landlord_ops', 'operations', 'coo', 'super_admin']
      )
    WHEN p_scope = 'agent_ops' THEN
      public._has_enabled_role(
        auth.uid(),
        ARRAY['agent_ops', 'operations', 'coo', 'super_admin']
      )
    WHEN p_scope = 'partner_ops' THEN
      public._has_enabled_role(
        auth.uid(),
        ARRAY['partner_ops', 'operations', 'coo', 'cfo', 'super_admin']
      )
    WHEN p_scope = 'finance' THEN
      public._has_enabled_role(
        auth.uid(),
        ARRAY['financial_ops', 'cfo', 'super_admin']
      )
    WHEN p_scope = 'hr' THEN
      public._has_enabled_role(
        auth.uid(),
        ARRAY['hr', 'super_admin']
      )
    WHEN p_scope = 'calling' THEN
      auth.uid() IN (
        '5295252d-f477-42a9-92f5-af56e503e33d'::uuid,
        'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid,
        'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid,
        'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid
      )
      OR public._has_enabled_role(
        auth.uid(),
        ARRAY['hr', 'tenant_ops', 'landlord_ops', 'operations', 'coo', 'super_admin']
      )
    ELSE
      public._has_enabled_role(
        auth.uid(),
        ARRAY['tenant_ops', 'landlord_ops', 'agent_ops', 'operations', 'coo', 'super_admin']
      )
  END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_can_view_pii(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_view_pii(text) TO authenticated;

-- =============================================================================
-- GROUP D: AGENT OPS (Questions 23–27, 5 tools)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- D1 (Q23). Agent Ops Network Overview (get_agent_ops_network_overview)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_aops_network_overview(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_min_expected numeric DEFAULT 50000
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
  v_from date := LEAST(coalesce(p_from, v_to - 29), v_to);
  v_min numeric := GREATEST(coalesce(p_min_expected, 50000), 0);
  v_allow_phones boolean;
  v_raw jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public.agent_ops_report_authorized()
     OR NOT (
       public.is_ops_role(v_uid)
       OR public._has_enabled_role(
         v_uid,
         ARRAY['operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Agent Ops network overview.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('agent_ops');
  v_raw := public.get_agent_ops_network_overview(v_from, v_to, v_min);

  RETURN jsonb_build_object(
    'source', 'get_agent_ops_network_overview (Agent Ops Network Overview)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'overview', public.staff_assistant_sanitize_jsonb(
      coalesce(v_raw, '{}'::jsonb),
      v_allow_phones,
      200
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_aops_network_overview(date, date, numeric) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_aops_network_overview(date, date, numeric) TO authenticated;

-- -----------------------------------------------------------------------------
-- D2 (Q24). Agent Ops Metrics Totals (agent_ops_metrics_totals)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_aops_metrics_totals(
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
  v_from date := LEAST(coalesce(p_from, v_to - 29), v_to);
  v_totals jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public.agent_ops_report_authorized()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['agent_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Agent Ops metrics totals.'
      USING ERRCODE = '42501';
  END IF;

  SELECT to_jsonb(r)
    INTO v_totals
    FROM public.agent_ops_metrics_totals(v_from, v_to) r
   LIMIT 1;

  RETURN jsonb_build_object(
    'source', 'agent_ops_metrics_totals (Agent Ops Metrics Totals)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'totals', coalesce(v_totals, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_aops_metrics_totals(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_aops_metrics_totals(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- D3 (Q25). Agent Ops Per-Agent Metrics (agent_ops_metrics_agents)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_aops_metrics_agents(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_sort text DEFAULT 'houses_listed',
  p_scope text DEFAULT 'qualifying',
  p_limit integer DEFAULT 50
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
  v_from date := LEAST(coalesce(p_from, v_to - 29), v_to);
  v_scope text := CASE
    WHEN lower(btrim(coalesce(p_scope, ''))) IN ('linked', 'qualifying', 'all')
      THEN lower(btrim(p_scope))
    ELSE 'qualifying'
  END;
  v_sort text := CASE
    WHEN lower(btrim(coalesce(p_sort, ''))) IN (
      'name', 'houses_listed', 'houses_approved', 'houses_pending',
      'houses_rejected', 'listing_earned', 'clawed_back', 'net',
      'advance_outstanding', 'last_listing'
    )
      THEN lower(btrim(p_sort))
    ELSE 'houses_listed'
  END;
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
  v_allow_phones boolean;
  v_rows jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public.agent_ops_report_authorized()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['agent_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Agent Ops per-agent metrics.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('agent_ops');

  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        to_jsonb(r) - 'agent_id' - 'main_agent_id',
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
      FROM public.agent_ops_metrics_agents(
        v_from,
        v_to,
        nullif(btrim(coalesce(p_search, '')), ''),
        v_sort,
        v_scope,
        v_limit,
        0
      )
     LIMIT v_limit
  ) r;

  RETURN jsonb_build_object(
    'source', 'agent_ops_metrics_agents (Agent Ops Per-Agent Metrics)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'scope', v_scope,
    'sort', v_sort,
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_aops_metrics_agents(date, date, text, text, text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_aops_metrics_agents(date, date, text, text, text, integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- D4 (Q26). Agent Ops Listing Quality & Risk (agent_ops_metrics_listing_quality + agent_ops_metrics_risk)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_aops_listing_quality_and_risk(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_limit integer DEFAULT 50
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
  v_from date := LEAST(coalesce(p_from, v_to - 29), v_to);
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 100);
  v_allow_phones boolean;
  v_quality jsonb;
  v_risk jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public.agent_ops_report_authorized()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['agent_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Agent Ops listing quality and risk reports.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('agent_ops');
  v_quality := public.agent_ops_metrics_listing_quality(v_from, v_to, v_limit, 0);
  v_risk := public.agent_ops_metrics_risk(v_from, v_to, v_limit, 0);

  RETURN jsonb_build_object(
    'source', 'agent_ops_metrics_listing_quality + agent_ops_metrics_risk (Agent Ops Listing Quality & Risk)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'listing_quality', public.staff_assistant_sanitize_jsonb(
      coalesce(v_quality, '{}'::jsonb),
      v_allow_phones,
      200
    ),
    'risk', public.staff_assistant_sanitize_jsonb(
      coalesce(v_risk, '{}'::jsonb),
      v_allow_phones,
      200
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_aops_listing_quality_and_risk(date, date, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_aops_listing_quality_and_risk(date, date, integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- D5 (Q27). Agent Ops Silent Collectors (agent_ops_silent_collectors)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_aops_silent_collectors(
  p_min_days_silent integer DEFAULT 3,
  p_limit integer DEFAULT 50
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
  v_days integer := LEAST(GREATEST(coalesce(p_min_days_silent, 3), 1), 60);
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
  v_allow_phones boolean;
  v_rows jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public.agent_ops_report_authorized()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['agent_ops', 'tenant_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Agent Ops silent collectors report.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('agent_ops');

  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        to_jsonb(r) - 'agent_id',
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
      FROM public.agent_ops_silent_collectors(v_days, v_limit)
     LIMIT v_limit
  ) r;

  RETURN jsonb_build_object(
    'source', 'agent_ops_silent_collectors (Agent Ops Silent Collectors)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'min_days_silent', v_days,
      'timezone', 'Africa/Kampala'
    ),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_aops_silent_collectors(integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_aops_silent_collectors(integer, integer) TO authenticated;

-- =============================================================================
-- GROUP E: PARTNER OPS & PSO (Questions 28–31, 4 tools)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- E1 (Q28). Partner Ops Pending Summary (partner_ops_pending_portfolio_summary + partner_ops_pending_summary)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_pops_pending_summary(
  p_month date DEFAULT NULL
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
  v_month date := date_trunc('month', coalesce(p_month, v_today))::date;
  v_portfolio_pending jsonb := '{}'::jsonb;
  v_notes_pending jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public.partner_ops_can_view()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['partner_ops', 'cfo', 'ceo', 'coo', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Partner Ops pending summaries.'
      USING ERRCODE = '42501';
  END IF;

  SELECT to_jsonb(r)
    INTO v_portfolio_pending
    FROM public.partner_ops_pending_portfolio_summary() r
   LIMIT 1;

  IF public._has_enabled_role(v_uid, ARRAY['super_admin', 'ceo', 'coo', 'cfo', 'hr']) THEN
    SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
      INTO v_notes_pending
      FROM (
        SELECT *
          FROM public.partner_ops_pending_summary(v_month)
         LIMIT 50
      ) r;
  END IF;

  RETURN jsonb_build_object(
    'source', 'partner_ops_pending_portfolio_summary + partner_ops_pending_summary (Partner Ops Pending Queue)',
    'period', jsonb_build_object(
      'month', v_month,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'pending_portfolios', coalesce(v_portfolio_pending, '{}'::jsonb),
    'promissory_notes_summary', coalesce(v_notes_pending, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_pops_pending_summary(date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_pops_pending_summary(date) TO authenticated;

-- -----------------------------------------------------------------------------
-- E2 (Q29). Partner Ops Report Overview (partner_ops_report_totals + partner_ops_report_breakdown)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_pops_report_overview(
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
  v_from date := LEAST(coalesce(p_from, v_to - 29), v_to);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_allow_phones boolean;
  v_totals jsonb;
  v_breakdown jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public.partner_ops_can_view()
       OR public._has_enabled_role(v_uid, ARRAY['financial_ops'])
     )
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['partner_ops', 'financial_ops', 'cfo', 'ceo', 'coo', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Partner Ops report overview.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('partner_ops');
  v_totals := public.partner_ops_report_totals();
  v_breakdown := public.partner_ops_report_breakdown(v_start, v_end);

  RETURN jsonb_build_object(
    'source', 'partner_ops_report_totals + partner_ops_report_breakdown (Partner Ops Portfolio & Returns Report)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'totals', coalesce(v_totals, '{}'::jsonb),
    'breakdown', public.staff_assistant_sanitize_jsonb(
      coalesce(v_breakdown, '{}'::jsonb),
      v_allow_phones,
      200
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_pops_report_overview(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_pops_report_overview(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- E3 (Q30). Partner Ops Supporter Search (partner_ops_search_partners)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_pops_search_supporters(
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50
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
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 100);
  v_allow_phones boolean;
  v_rows jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public.partner_ops_can_view()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['partner_ops', 'cfo', 'ceo', 'coo', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Partner Ops Supporter directory search.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('partner_ops');

  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        to_jsonb(r) - 'user_id',
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
      FROM public.partner_ops_search_partners(
        nullif(btrim(coalesce(p_search, '')), ''),
        v_limit
      )
     LIMIT v_limit
  ) r;

  RETURN jsonb_build_object(
    'source', 'partner_ops_search_partners (Partner Ops Supporter Directory)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_pops_search_supporters(text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_pops_search_supporters(text, integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- E4 (Q31). PSO Cohort & Promissory Note Performance (pso_funded_summary + pso_promise_summary + pso_cohort_volume)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_pso_cohort_performance(
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
  v_from date := GREATEST(LEAST(coalesce(p_from, v_to - 29), v_to), v_to - 365);
  v_funded jsonb;
  v_promise jsonb;
  v_volume jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public.pso_can_view_my_performance()
     OR NOT (
       public.pso_is_officer()
       OR public.hr_is_admin()
       OR public.hr_is_executive()
       OR public._has_enabled_role(v_uid, ARRAY['hr', 'coo', 'ceo', 'super_admin'])
     )
  THEN
    RAISE EXCEPTION 'Not authorized for PSO cohort performance reports.'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(r) - 'staff_id'), '[]'::jsonb)
    INTO v_funded
    FROM (
      SELECT *
        FROM public.pso_funded_summary(v_from, v_to, NULL)
       LIMIT 200
    ) r;

  SELECT coalesce(jsonb_agg(to_jsonb(r) - 'staff_id'), '[]'::jsonb)
    INTO v_promise
    FROM (
      SELECT *
        FROM public.pso_promise_summary(v_from, v_to, NULL)
       LIMIT 200
    ) r;

  SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    INTO v_volume
    FROM (
      SELECT *
        FROM public.pso_cohort_volume(v_from, v_to)
       LIMIT 200
    ) r;

  RETURN jsonb_build_object(
    'source', 'pso_funded_summary + pso_promise_summary + pso_cohort_volume (PSO Cohort Performance)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'funded_summary', coalesce(v_funded, '[]'::jsonb),
    'promise_summary', coalesce(v_promise, '[]'::jsonb),
    'cohort_volume', coalesce(v_volume, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_pso_cohort_performance(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_pso_cohort_performance(date, date) TO authenticated;

-- =============================================================================
-- GROUP F: CFO & FINANCIAL OPS (Questions 32–36, 6 tools)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- F1 (Q32). Treasury Cash Position — SINGLE SOURCE OF TRUTH (get_treasury_cash_position)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_cfo_treasury_cash_position(
  p_as_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_as_at timestamptz := coalesce(p_as_at, now());
  v_position jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_finance_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['cfo', 'ceo', 'coo', 'manager', 'financial_ops', 'cto', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Treasury cash position.'
      USING ERRCODE = '42501';
  END IF;

  v_position := public.get_treasury_cash_position(v_as_at);

  RETURN jsonb_build_object(
    'source', 'get_treasury_cash_position (Treasury Cash Position — A1/A5/A21/A22)',
    'period', jsonb_build_object(
      'as_at', v_as_at,
      'timezone', 'Africa/Kampala'
    ),
    'cash_position', coalesce(v_position, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_cfo_treasury_cash_position(timestamptz) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_cfo_treasury_cash_position(timestamptz) TO authenticated;

-- -----------------------------------------------------------------------------
-- F2 (Q33). CFO Money Received & Paid Out Summary (get_cfo_money_received + get_cfo_money_paid_out)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_cfo_money_flow_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_received jsonb;
  v_paid_out jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_finance_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['cfo', 'ceo', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for CFO money flow summary.'
      USING ERRCODE = '42501';
  END IF;

  SELECT to_jsonb(r)
    INTO v_received
    FROM public.get_cfo_money_received() r
   LIMIT 1;

  SELECT to_jsonb(p)
    INTO v_paid_out
    FROM public.get_cfo_money_paid_out() p
   LIMIT 1;

  RETURN jsonb_build_object(
    'source', 'get_cfo_money_received + get_cfo_money_paid_out (CFO Money Flow Summary)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'money_received', coalesce(v_received, '{}'::jsonb),
    'money_paid_out', coalesce(v_paid_out, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_cfo_money_flow_summary() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_cfo_money_flow_summary() TO authenticated;

-- -----------------------------------------------------------------------------
-- F3 (Q34). Receivables, Payables & Predictive Forecast (get_receivables_total + get_payables_total + get_payables_predictive_forecast)
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
  v_forecast := public.get_payables_predictive_forecast(v_gran, v_periods, v_today);

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
-- F4 (Q35a). CFO 7-Day Platform Expenses (get_cfo_seven_day_expenses)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_cfo_seven_day_expenses()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_rows jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_finance_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['cfo', 'ceo', 'coo', 'manager', 'financial_ops', 'cto', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for CFO seven-day platform expenses.'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT *
        FROM public.get_cfo_seven_day_expenses()
       LIMIT 200
    ) r;

  RETURN jsonb_build_object(
    'source', 'get_cfo_seven_day_expenses (CFO 7-Day Platform Expenses)',
    'period', jsonb_build_object(
      'from', v_today - 7,
      'to', v_today + 6,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_cfo_seven_day_expenses() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_cfo_seven_day_expenses() TO authenticated;

-- -----------------------------------------------------------------------------
-- F5 (Q35b). CFO Revised Budget Position (budget_revised_position)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_cfo_budget_revised_position()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_call_id uuid;
  v_call_title text;
  v_period_start date;
  v_period_end date;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_finance_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['cfo', 'ceo', 'coo', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for revised budget position.'
      USING ERRCODE = '42501';
  END IF;

  SELECT bc.id, bc.title, bc.period_start, bc.period_end
    INTO v_call_id, v_call_title, v_period_start, v_period_end
    FROM public.budget_calls bc
   ORDER BY bc.period_start DESC NULLS LAST, bc.created_at DESC
   LIMIT 1;

  IF v_call_id IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(to_jsonb(r) - 'department_id' - 'submission_id' - 'line_id'), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT *
          FROM public.budget_revised_position(v_call_id)
         LIMIT 200
      ) r;
  END IF;

  RETURN jsonb_build_object(
    'source', 'budget_revised_position (CFO Revised Budget Position)',
    'period', jsonb_build_object(
      'from', coalesce(v_period_start, v_today),
      'to', coalesce(v_period_end, v_today),
      'cycle_title', v_call_title,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_cfo_budget_revised_position() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_cfo_budget_revised_position() TO authenticated;

-- -----------------------------------------------------------------------------
-- F6 (Q36). Financial Ops Payout Verification Queue & CFO Approved Requisitions
--           (finops_payout_verification_counts + cfo_approved_requisitions)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_fops_verification_and_requisitions(
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
  v_from date := LEAST(coalesce(p_from, v_to - 29), v_to);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_verification jsonb := '{}'::jsonb;
  v_requisitions jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_finance_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['financial_ops', 'cfo', 'ceo', 'coo', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Financial Ops verification and requisition reports.'
      USING ERRCODE = '42501';
  END IF;

  IF public._has_enabled_role(v_uid, ARRAY['financial_ops', 'cfo', 'super_admin']) THEN
    v_verification := public.finops_payout_verification_counts();
  END IF;

  SELECT coalesce(
    jsonb_agg(
      to_jsonb(r) - 'requisition_id' - 'receiver_id'
    ),
    '[]'::jsonb
  )
  INTO v_requisitions
  FROM (
    SELECT *
      FROM public.cfo_approved_requisitions(v_start, v_end)
     LIMIT 200
  ) r;

  RETURN jsonb_build_object(
    'source', 'finops_payout_verification_counts + cfo_approved_requisitions (Financial Ops Verification & Requisitions)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'payout_verification_counts', coalesce(v_verification, '{}'::jsonb),
    'approved_requisition_count', jsonb_array_length(v_requisitions),
    'approved_requisitions', v_requisitions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_fops_verification_and_requisitions(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_fops_verification_and_requisitions(date, date) TO authenticated;

-- =============================================================================
-- GROUP G: COO, CEO & MANAGERS (Questions 37–38, 2 tools)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- G1 (Q37). COO Command Center, Overview Snapshot & Rent Coverage Statement
--           (get_coo_command_center + get_coo_overview_snapshot + get_coo_rent_coverage_statement)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_coo_overview(
  p_days integer DEFAULT 14,
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
  v_days integer := LEAST(GREATEST(coalesce(p_days, 14), 3), 60);
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_from date := LEAST(coalesce(p_from, v_to - (v_days - 1)), v_to);
  v_command jsonb;
  v_snapshot jsonb;
  v_coverage jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['coo', 'ceo', 'cfo', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for COO executive overview.'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_command := public.get_coo_command_center();
  EXCEPTION
    WHEN OTHERS THEN
      v_command := '{}'::jsonb;
  END;

  v_snapshot := public.get_coo_overview_snapshot(v_days, v_from, v_to);
  v_coverage := public.get_coo_rent_coverage_statement();

  RETURN jsonb_build_object(
    'source', 'get_coo_command_center + get_coo_overview_snapshot + get_coo_rent_coverage_statement (COO Executive Overview)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'days', v_days,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'command_center', coalesce(v_command, '{}'::jsonb),
    'overview_snapshot', public.staff_assistant_sanitize_jsonb(
      coalesce(v_snapshot, '{}'::jsonb),
      true,
      200
    ),
    'rent_coverage_statement', coalesce(v_coverage, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_coo_overview(integer, date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_coo_overview(integer, date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- G2 (Q38). CEO Growth Quality & Pending Requisition Prompt
--           (get_ceo_growth_quality + staff_requisition_pending_prompt)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_ceo_growth_and_approvals(
  p_days integer DEFAULT 30
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
  v_days integer := LEAST(GREATEST(coalesce(p_days, 30), 1), 180);
  v_growth jsonb;
  v_prompt jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['ceo', 'coo', 'cfo', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for CEO growth quality and executive approvals.'
      USING ERRCODE = '42501';
  END IF;

  v_growth := public.get_ceo_growth_quality(v_days);

  SELECT to_jsonb(r) - 'prompt_id' - 'requisition_id'
    INTO v_prompt
    FROM public.staff_requisition_pending_prompt() r
   LIMIT 1;

  RETURN jsonb_build_object(
    'source', 'get_ceo_growth_quality + staff_requisition_pending_prompt (CEO Growth Quality & Approvals)',
    'period', jsonb_build_object(
      'days', v_days,
      'from', v_today - (v_days - 1),
      'to', v_today,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'growth_quality', coalesce(v_growth, '{}'::jsonb),
    'next_pending_requisition', coalesce(v_prompt, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_ceo_growth_and_approvals(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_ceo_growth_and_approvals(integer) TO authenticated;

-- =============================================================================
-- GROUP H: HR & CALLING TEAM (Questions 39–40, 3 tools)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- H1 (Q39). Staff Calling Detailed Report & Weekly All-Calls Summary
--           (staff_calling_detailed_report + cc_weekly_all_calls_report)
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
  v_detailed jsonb;
  v_weekly_summary jsonb;
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

  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        to_jsonb(r) - 'staff_id' - 'rr_id' - 'person_id',
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_detailed
  FROM (
    SELECT *
      FROM public.staff_calling_detailed_report(v_start, v_end)
     LIMIT 200
  ) r;

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
    'detailed_row_count', jsonb_array_length(v_detailed),
    'detailed_rows', v_detailed,
    'weekly_all_calls_summary', v_weekly_summary
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_hr_calling_detailed_report(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_hr_calling_detailed_report(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- H2 (Q40a). HR Expiring Contracts & Upcoming Staff Birthdays
--            (hr_contracts_expiring + hr_list_staff_birthdays)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_hr_contracts_and_birthdays(
  p_days integer DEFAULT 60
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
  v_days integer := LEAST(GREATEST(coalesce(p_days, 60), 1), 180);
  v_contracts jsonb := '[]'::jsonb;
  v_birthdays jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public.hr_is_admin()
       OR public.hr_is_executive()
       OR public._has_enabled_role(
         v_uid,
         ARRAY['hr', 'coo', 'ceo', 'cfo', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for HR expiring contracts and birthday reports.'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(
    jsonb_agg(to_jsonb(r) - 'contract_id'),
    '[]'::jsonb
  )
  INTO v_contracts
  FROM (
    SELECT *
      FROM public.hr_contracts_expiring(v_days)
     LIMIT 200
  ) r;

  BEGIN
    SELECT coalesce(
      jsonb_agg(to_jsonb(b) - 'staff_id' - 'birth_date'),
      '[]'::jsonb
    )
    INTO v_birthdays
    FROM (
      SELECT *
        FROM public.hr_list_staff_birthdays()
       WHERE days_until IS NOT NULL AND days_until <= v_days
       LIMIT 200
    ) b;
  EXCEPTION
    WHEN OTHERS THEN
      v_birthdays := '[]'::jsonb;
  END;

  RETURN jsonb_build_object(
    'source', 'hr_contracts_expiring + hr_list_staff_birthdays (HR Expiring Contracts & Upcoming Birthdays)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'horizon_days', v_days,
      'timezone', 'Africa/Kampala'
    ),
    'expiring_contract_count', jsonb_array_length(v_contracts),
    'expiring_contracts', v_contracts,
    'upcoming_birthday_count', jsonb_array_length(v_birthdays),
    'upcoming_birthdays', v_birthdays
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_hr_contracts_and_birthdays(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_hr_contracts_and_birthdays(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- H3 (Q40b). HR Payroll Cost by Department (hr_pay_cost_by_department)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_hr_payroll_cost_by_department(
  p_period_code text DEFAULT NULL
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
  v_code text := nullif(btrim(coalesce(p_period_code, '')), '');
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public.hr_pay_is_rule_reader()
       OR public.hr_pay_is_preparer()
       OR public.hr_pay_is_approver()
       OR public._has_enabled_role(
         v_uid,
         ARRAY['cfo', 'coo', 'ceo', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for HR payroll department cost reports.'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT *
        FROM public.hr_pay_cost_by_department(v_code)
       LIMIT 200
    ) r;

  RETURN jsonb_build_object(
    'source', 'hr_pay_cost_by_department (HR Payroll Cost by Department)',
    'period', jsonb_build_object(
      'period_code', coalesce(v_code, 'all_current'),
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_hr_payroll_cost_by_department(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_hr_payroll_cost_by_department(text) TO authenticated;

COMMIT;
