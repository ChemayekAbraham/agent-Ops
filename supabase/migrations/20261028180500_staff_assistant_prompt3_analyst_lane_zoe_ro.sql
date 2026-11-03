-- =============================================================================
-- Migration: 20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql
-- Purpose:   Zoe (My Space Staff Assistant) — Prompt 3: The Analyst Lane
--            (any data question, read-only):
--              1. Create `zoe_ro` schema of 18 read-only `security_invoker = true`
--                 views grouped across 8 role areas (`finance`, `operations`,
--                 `calling`, `hr`, `agents`, `supporters`, `tenants`, `landlords`),
--                 built on the official functions and live tables, omitting or
--                 masking PII, with plain-language descriptions and
--                 "use this for / do not use this for" notes.
--              2. Create `public.staff_assistant_data_catalog` + read-only
--                 `public.assistant_staff_data_catalog(p_area)` and alias
--                 `public.get_data_catalog(p_area)` (`STABLE SECURITY DEFINER`).
--              3. Create append-only `public.staff_assistant_queries` (RLS,
--                 `mfa_required_for_staff` policy, `SELECT` only for `authenticated`,
--                 no user delete, append-only trigger) + logger helper
--                 `public.staff_assistant_log_query`.
--              4. Create `public.zoe_ro_validate_query(p_sql)` and
--                 `public.assistant_staff_run_query(p_sql, p_question)`
--                 (`SECURITY INVOKER`, `STABLE`, `statement_timeout = '5s'`,
--                 `transaction_read_only = on`, 500-row cap with `truncated`
--                 flag, strict single-SELECT firewall, function allow-list,
--                 `zoe_ro`-only object enforcement, role-area & `require_staff_aal2()`
--                 checks, and query audit logging).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Schema `zoe_ro` & Role-Area Access Enforcement Helpers
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS zoe_ro;

REVOKE ALL ON SCHEMA zoe_ro FROM PUBLIC, anon, service_role;
GRANT USAGE ON SCHEMA zoe_ro TO authenticated;

CREATE OR REPLACE FUNCTION public.zoe_ro_area_requires_aal2(
  p_area text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT lower(btrim(COALESCE(p_area, ''))) IN ('finance', 'hr', 'supporters');
$function$;

REVOKE ALL ON FUNCTION public.zoe_ro_area_requires_aal2(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.zoe_ro_area_requires_aal2(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.zoe_ro_area_allowed(
  p_area text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_area text := lower(btrim(COALESCE(p_area, '')));
  v_is_calling_member boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RETURN false;
  END IF;

  IF NOT public.staff_mfa_ok() THEN
    RETURN false;
  END IF;

  IF public.zoe_ro_area_requires_aal2(v_area) THEN
    IF COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal',
      'aal1'
    ) <> 'aal2' THEN
      RETURN false;
    END IF;
  END IF;

  IF v_area = 'finance' THEN
    RETURN public.can_view_finance_reports(v_uid)
      AND public._has_enabled_role(
        v_uid,
        ARRAY['cfo', 'ceo', 'coo', 'financial_ops', 'manager', 'cto', 'super_admin']
      );
  ELSIF v_area = 'operations' THEN
    RETURN public.can_view_staff_reports(v_uid)
      AND (
        public.is_ops_role(v_uid)
        OR public._has_enabled_role(
          v_uid,
          ARRAY['operations', 'tenant_ops', 'landlord_ops', 'agent_ops', 'partner_ops', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
        )
      );
  ELSIF v_area = 'calling' THEN
    v_is_calling_member := v_uid IN (
      '5295252d-f477-42a9-92f5-af56e503e33d'::uuid,
      'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid,
      'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid,
      'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid
    );
    RETURN public.can_view_staff_reports(v_uid)
      AND (
        v_is_calling_member
        OR public.hr_is_admin()
        OR public._has_enabled_role(
          v_uid,
          ARRAY['tenant_ops', 'landlord_ops', 'operations', 'crm', 'hr', 'coo', 'ceo', 'cfo', 'manager', 'super_admin']
        )
      );
  ELSIF v_area = 'hr' THEN
    RETURN public.can_view_staff_reports(v_uid)
      AND (
        public.hr_is_admin()
        OR public.hr_is_executive()
        OR public._has_enabled_role(
          v_uid,
          ARRAY['hr', 'coo', 'ceo', 'cfo', 'super_admin']
        )
      );
  ELSIF v_area = 'agents' THEN
    RETURN public.can_view_staff_reports(v_uid)
      AND (
        public.agent_ops_report_authorized()
        OR public._has_enabled_role(
          v_uid,
          ARRAY['agent_ops', 'tenant_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
        )
      );
  ELSIF v_area = 'supporters' THEN
    RETURN public.can_view_staff_reports(v_uid)
      AND (
        public.partner_ops_can_view()
        OR public._has_enabled_role(v_uid, ARRAY['financial_ops'])
      )
      AND public._has_enabled_role(
        v_uid,
        ARRAY['partner_ops', 'financial_ops', 'cfo', 'ceo', 'coo', 'manager', 'super_admin']
      );
  ELSIF v_area = 'tenants' THEN
    RETURN public.can_view_staff_reports(v_uid)
      AND (
        public.is_ops_role(v_uid)
        OR public._has_enabled_role(
          v_uid,
          ARRAY['tenant_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
        )
      );
  ELSIF v_area = 'landlords' THEN
    RETURN public.can_view_staff_reports(v_uid)
      AND (
        public.is_ops_role(v_uid)
        OR public._has_enabled_role(
          v_uid,
          ARRAY['landlord_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
        )
      );
  ELSE
    RETURN false;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.zoe_ro_area_allowed(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.zoe_ro_area_allowed(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.zoe_ro_require_area(
  p_area text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_area text := lower(btrim(COALESCE(p_area, '')));
BEGIN
  IF auth.uid() IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required for zoe_ro.%', v_area
      USING ERRCODE = '42501';
  END IF;

  IF public.zoe_ro_area_requires_aal2(v_area) THEN
    PERFORM public.require_staff_aal2();
  END IF;

  IF NOT public.zoe_ro_area_allowed(v_area) THEN
    RAISE EXCEPTION 'Not authorized: caller role cannot read zoe_ro area "%"', v_area
      USING ERRCODE = '42501';
  END IF;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.zoe_ro_require_area(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.zoe_ro_require_area(text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Approved Read-Only Views in `zoe_ro` (`WITH (security_invoker = true)`)
--    Grouped across 8 role areas:
--      (a) finance    (4 views)
--      (b) operations (2 views)
--      (c) calling    (2 views)
--      (d) hr         (2 views)
--      (e) agents     (2 views)
--      (f) supporters (2 views)
--      (g) tenants    (2 views)
--      (h) landlords  (2 views)
-- -----------------------------------------------------------------------------

-- === AREA 1: FINANCE ===

CREATE OR REPLACE VIEW zoe_ro.finance_treasury_cash_position
WITH (security_invoker = true)
AS
SELECT
  ((now() AT TIME ZONE 'Africa/Kampala')::date) AS as_of_date,
  COALESCE((pos.payload ->> 'total_available_cash')::numeric, (pos.payload ->> 'treasury_cash')::numeric, 0) AS total_available_cash_ugx,
  COALESCE((pos.payload ->> 'a1_cash_and_bank')::numeric, (pos.payload ->> 'cash_and_bank')::numeric, 0) AS a1_cash_and_bank_ugx,
  COALESCE((pos.payload ->> 'a5_cash_in_transit')::numeric, (pos.payload ->> 'cash_in_transit')::numeric, 0) AS a5_cash_in_transit_ugx,
  COALESCE((pos.payload ->> 'a2_agent_float')::numeric, (pos.payload ->> 'agent_float')::numeric, 0) AS a2_agent_float_ugx,
  'get_treasury_cash_position'::text AS official_source
FROM (
  SELECT public.get_treasury_cash_position(now()) AS payload
) pos
WHERE public.zoe_ro_require_area('finance');

COMMENT ON VIEW zoe_ro.finance_treasury_cash_position IS
  'Official Treasury Cash Position (A1 Cash & Bank + A5 Cash in Transit, plus A2 Agent Float reported separately). Use this for: checking available platform cash and treasury balances. Do not use this for: summing general_ledger or wallets directly, or treating A2 agent float as treasury cash.';

CREATE OR REPLACE VIEW zoe_ro.finance_receivables_and_payables
WITH (security_invoker = true)
AS
SELECT
  ((now() AT TIME ZONE 'Africa/Kampala')::date) AS as_of_date,
  COALESCE((rec.payload ->> 'total_receivables')::numeric, (rec.payload ->> 'receivables_total')::numeric, 0) AS total_receivables_ugx,
  COALESCE((rec.payload ->> 'active_plans_count')::integer, (rec.payload ->> 'active_count')::integer, 0) AS active_rent_plans_count,
  COALESCE((rec.payload ->> 'overdue_receivables')::numeric, 0) AS overdue_receivables_ugx,
  COALESCE((pay.payload ->> 'total_payables')::numeric, (pay.payload ->> 'payables_total')::numeric, 0) AS total_payables_ugx,
  COALESCE((pay.payload ->> 'landlord_payables')::numeric, 0) AS landlord_payables_ugx,
  COALESCE((pay.payload ->> 'supporter_payables')::numeric, 0) AS supporter_returns_payable_ugx,
  'get_receivables_total + get_payables_total'::text AS official_source
FROM (SELECT public.get_receivables_total() AS payload) rec
CROSS JOIN (SELECT public.get_payables_total() AS payload) pay
WHERE public.zoe_ro_require_area('finance');

COMMENT ON VIEW zoe_ro.finance_receivables_and_payables IS
  'Official company Receivables (A3 Rent Plan book) and Payables totals from get_receivables_total() and get_payables_total(). Use this for: high-level receivables vs payables comparisons. Do not use this for: agent lending (excluded from company receivables) or unverified merchandise plans.';

CREATE OR REPLACE VIEW zoe_ro.finance_requisitions_summary
WITH (security_invoker = true)
AS
SELECT
  sr.requisition_code,
  sr.title,
  COALESCE(sr.department_key, 'unassigned') AS department_key,
  COALESCE(sr.category, 'general') AS category,
  sr.request_kind,
  sr.stage,
  sr.final_stage,
  sr.amount::numeric AS requested_amount_ugx,
  COALESCE(sr.approved_amount, 0)::numeric AS approved_amount_ugx,
  COALESCE(sr.wallet_credit_status, 'pending') AS wallet_credit_status,
  (sr.created_at AT TIME ZONE 'Africa/Kampala')::date AS created_date,
  (sr.decided_at AT TIME ZONE 'Africa/Kampala')::date AS decided_date
FROM public.staff_requisitions sr
WHERE public.zoe_ro_require_area('finance');

COMMENT ON VIEW zoe_ro.finance_requisitions_summary IS
  'Staff requisitions by department, category, approval stage, and UGX amount (PII and requester IDs omitted). Use this for: analysing requisition volumes, approval stages, and spend by department or category. Do not use this for: treasury cash balances or approving/rejecting requisitions.';

CREATE OR REPLACE VIEW zoe_ro.finance_budget_cycles
WITH (security_invoker = true)
AS
SELECT
  bc.title AS cycle_title,
  COALESCE(bc.financial_year, '') AS financial_year,
  bc.period_type,
  bc.period_start,
  bc.period_end,
  bc.status,
  (bc.deadline AT TIME ZONE 'Africa/Kampala')::date AS deadline_date,
  (bc.created_at AT TIME ZONE 'Africa/Kampala')::date AS created_date
FROM public.budget_calls bc
WHERE public.zoe_ro_require_area('finance');

COMMENT ON VIEW zoe_ro.finance_budget_cycles IS
  'Company budget call cycles and periods from budget_calls. Use this for: checking budget cycle dates, financial years, and cycle status. Do not use this for: actual cash disbursements.';

-- === AREA 2: OPERATIONS ===

CREATE OR REPLACE VIEW zoe_ro.operations_daily_collection_coverage
WITH (security_invoker = true)
AS
WITH daily_bills AS (
  SELECT
    b.day AS collection_day,
    b.rent_request_id,
    b.expected_ugx::numeric AS expected_ugx
  FROM public.agent_expected_day_plans b
),
daily_receipts AS (
  SELECT
    (c.created_at AT TIME ZONE 'Africa/Kampala')::date AS collection_day,
    c.rent_request_id,
    SUM(c.amount)::numeric AS paid_ugx
  FROM public.agent_collections c
  WHERE c.reversed_at IS NULL
    AND (c.notes IS NULL OR c.notes NOT ILIKE '%[REVERSED:%')
    AND c.amount > 0
  GROUP BY (c.created_at AT TIME ZONE 'Africa/Kampala')::date, c.rent_request_id
),
joined_day AS (
  SELECT
    COALESCE(b.collection_day, r.collection_day) AS collection_day,
    COUNT(b.rent_request_id)::integer AS plans_billed_count,
    COALESCE(SUM(b.expected_ugx), 0)::numeric AS expected_pinned_ugx,
    COALESCE(SUM(CASE WHEN b.rent_request_id IS NOT NULL THEN COALESCE(r.paid_ugx, 0) ELSE 0 END), 0)::numeric AS collected_on_schedule_ugx,
    COALESCE(SUM(CASE WHEN b.rent_request_id IS NOT NULL THEN LEAST(COALESCE(r.paid_ugx, 0), b.expected_ugx) ELSE 0 END), 0)::numeric AS collected_capped_ugx,
    COALESCE(SUM(CASE WHEN b.rent_request_id IS NULL THEN COALESCE(r.paid_ugx, 0) ELSE 0 END), 0)::numeric AS collected_arrears_ugx,
    COALESCE(SUM(COALESCE(r.paid_ugx, 0)), 0)::numeric AS total_cash_collected_ugx
  FROM daily_bills b
  FULL OUTER JOIN daily_receipts r
    ON b.collection_day = r.collection_day
   AND b.rent_request_id = r.rent_request_id
  GROUP BY COALESCE(b.collection_day, r.collection_day)
)
SELECT
  j.collection_day,
  j.plans_billed_count,
  j.expected_pinned_ugx,
  j.collected_on_schedule_ugx,
  j.collected_capped_ugx,
  j.collected_arrears_ugx,
  j.total_cash_collected_ugx,
  CASE
    WHEN j.expected_pinned_ugx > 0
      THEN ROUND((j.collected_on_schedule_ugx / j.expected_pinned_ugx) * 100.0, 1)
    ELSE 0::numeric
  END AS true_on_schedule_coverage_pct,
  CASE
    WHEN j.expected_pinned_ugx > 0
      THEN ROUND((j.collected_capped_ugx / j.expected_pinned_ugx) * 100.0, 1)
    ELSE 0::numeric
  END AS capped_coverage_pct
FROM joined_day j
WHERE j.collection_day IS NOT NULL
  AND public.zoe_ro_require_area('operations');

COMMENT ON VIEW zoe_ro.operations_daily_collection_coverage IS
  'Daily Rent Plan collection coverage built per welile-expected-vs-collected rules: joins agent_expected_day_plans (00:05 EAT pinned bill) to non-reversed agent_collections by (collection_day, rent_request_id). Reports four distinct figures: expected_pinned_ugx, collected_on_schedule_ugx, collected_arrears_ugx, and total_cash_collected_ugx. Use this for: daily/weekly collection coverage and expected vs collected comparisons. Do not use this for: dividing total_cash_collected_ugx by expected_pinned_ugx (which overstates coverage ~2x by mixing arrears into today''s bill).';

CREATE OR REPLACE VIEW zoe_ro.operations_rent_plans_by_stage
WITH (security_invoker = true)
AS
SELECT
  COALESCE(rr.status, 'unknown') AS stage,
  COALESCE(rr.tenancy_status, 'unknown') AS tenancy_status,
  COALESCE(NULLIF(btrim(rr.request_city), ''), 'Unspecified') AS request_city,
  COALESCE(rr.house_category, 'standard') AS house_category,
  COUNT(*)::integer AS plans_count,
  COALESCE(SUM(rr.rent_amount), 0)::numeric AS total_rent_ugx,
  COALESCE(SUM(rr.access_fee), 0)::numeric AS total_access_fee_ugx,
  COALESCE(SUM(rr.total_repayment), 0)::numeric AS total_repayment_ugx,
  COALESCE(SUM(rr.amount_repaid), 0)::numeric AS total_repaid_ugx,
  COALESCE(SUM(GREATEST(rr.total_repayment - rr.amount_repaid, 0)), 0)::numeric AS outstanding_ugx,
  ROUND(AVG(rr.daily_repayment), 0)::numeric AS avg_daily_repayment_ugx
FROM public.rent_requests rr
WHERE rr.status IS DISTINCT FROM 'deleted_by_agent'
  AND public.zoe_ro_require_area('operations')
GROUP BY
  COALESCE(rr.status, 'unknown'),
  COALESCE(rr.tenancy_status, 'unknown'),
  COALESCE(NULLIF(btrim(rr.request_city), ''), 'Unspecified'),
  COALESCE(rr.house_category, 'standard');

COMMENT ON VIEW zoe_ro.operations_rent_plans_by_stage IS
  'Aggregated Rent Plans grouped by stage, tenancy_status, request_city, and house_category (PII omitted). Use this for: comparing Rent Plan pipeline stages, cities, and house categories. Do not use this for: individual tenant phone lookups or treasury cash.';

-- === AREA 3: CALLING ===

CREATE OR REPLACE VIEW zoe_ro.calling_daily_attempts_summary
WITH (security_invoker = true)
AS
SELECT
  (COALESCE(a.recorded_at, a.created_at) AT TIME ZONE 'Africa/Kampala')::date AS call_day,
  COALESCE(a.source, 'calling_center') AS source_center,
  COALESCE(a.channel::text, 'phone') AS channel,
  COALESCE(a.outcome::text, 'unknown') AS outcome,
  (a.outcome::text = 'engaged') AS is_answered,
  COUNT(*)::integer AS attempts_count,
  COUNT(DISTINCT a.caller_id)::integer AS distinct_callers_count
FROM public.cc_call_attempts a
WHERE a.void_reason IS NULL
  AND a.outcome IS NOT NULL
  AND public.zoe_ro_require_area('calling')
GROUP BY
  (COALESCE(a.recorded_at, a.created_at) AT TIME ZONE 'Africa/Kampala')::date,
  COALESCE(a.source, 'calling_center'),
  COALESCE(a.channel::text, 'phone'),
  COALESCE(a.outcome::text, 'unknown'),
  (a.outcome::text = 'engaged');

COMMENT ON VIEW zoe_ro.calling_daily_attempts_summary IS
  'Daily Calling Center call attempts grouped by call_day (Africa/Kampala), source_center, channel, and outcome (excludes voided attempts; omits callee phones). Use this for: daily and Wednesday-to-Tuesday weekly call volume and answer-rate analysis. Do not use this for: individual callee phone numbers.';

CREATE OR REPLACE VIEW zoe_ro.calling_pipeline_awareness_summary
WITH (security_invoker = true)
AS
SELECT
  (c.recorded_at AT TIME ZONE 'Africa/Kampala')::date AS call_day,
  COALESCE(c.caller_team, 'ops') AS caller_team,
  COALESCE(c.pipeline_stage, 'unknown') AS pipeline_stage,
  COALESCE(c.subject_type, 'unknown') AS subject_type,
  COALESCE(c.call_result, 'unknown') AS call_result,
  COALESCE(c.landlord_consent, 'not_recorded') AS landlord_consent,
  COUNT(*)::integer AS calls_count
FROM public.rent_pipeline_awareness_calls c
WHERE public.zoe_ro_require_area('calling')
GROUP BY
  (c.recorded_at AT TIME ZONE 'Africa/Kampala')::date,
  COALESCE(c.caller_team, 'ops'),
  COALESCE(c.pipeline_stage, 'unknown'),
  COALESCE(c.subject_type, 'unknown'),
  COALESCE(c.call_result, 'unknown'),
  COALESCE(c.landlord_consent, 'not_recorded');

COMMENT ON VIEW zoe_ro.calling_pipeline_awareness_summary IS
  'Rent Plan pipeline awareness calls grouped by call_day, caller_team, pipeline_stage, subject_type, call_result, and landlord_consent (omits subject_phone and OTP fields). Use this for: awareness call reach and consent breakdowns. Do not use this for: payout authorization (awareness calls are informational only).';

-- === AREA 4: HR ===

CREATE OR REPLACE VIEW zoe_ro.hr_department_headcount
WITH (security_invoker = true)
AS
SELECT
  d.key AS department_key,
  d.name AS department_name,
  d.measurement_mode::text AS measurement_mode,
  COUNT(DISTINCT CASE WHEN hs.active IS TRUE AND ha.ended_on IS NULL THEN hs.id END)::integer AS active_staff_count,
  COUNT(DISTINCT CASE WHEN hs.active IS TRUE AND ha.ended_on IS NULL AND ha.is_primary IS TRUE THEN ha.id END)::integer AS primary_assignments_count,
  COUNT(DISTINCT hp.id)::integer AS positions_count
FROM public.hr_departments d
LEFT JOIN public.hr_positions hp ON hp.department_id = d.id AND hp.active IS TRUE
LEFT JOIN public.hr_assignments ha ON ha.department_id = d.id AND ha.ended_on IS NULL
LEFT JOIN public.hr_staff hs ON hs.id = ha.staff_id
WHERE d.active IS TRUE
  AND public.zoe_ro_require_area('hr')
GROUP BY d.key, d.name, d.measurement_mode;

COMMENT ON VIEW zoe_ro.hr_department_headcount IS
  'Active staff headcount, primary assignments, and positions by HR department (omits individual staff names, phones, and salaries). Use this for: department headcount and structure comparisons. Do not use this for: payroll disbursement totals.';

CREATE OR REPLACE VIEW zoe_ro.hr_contracts_overview
WITH (security_invoker = true)
AS
SELECT
  hc.contract_type,
  hc.signature_status,
  hc.currency,
  hc.start_date,
  hc.end_date,
  CASE
    WHEN hc.end_date IS NOT NULL
      THEN (hc.end_date - ((now() AT TIME ZONE 'Africa/Kampala')::date))::integer
    ELSE NULL
  END AS days_to_expiry,
  COUNT(*)::integer AS contracts_count,
  COALESCE(SUM(hc.value_amount), 0)::numeric AS total_value_ugx
FROM public.hr_contracts hc
WHERE public.zoe_ro_require_area('hr')
GROUP BY
  hc.contract_type,
  hc.signature_status,
  hc.currency,
  hc.start_date,
  hc.end_date;

COMMENT ON VIEW zoe_ro.hr_contracts_overview IS
  'HR contracts grouped by contract_type, signature_status, start_date, and end_date (counterparty PII omitted). Use this for: tracking contract expiry windows and signature statuses. Do not use this for: individual payslip lookups.';

-- === AREA 5: AGENTS ===

CREATE OR REPLACE VIEW zoe_ro.agents_daily_collections_by_region
WITH (security_invoker = true)
AS
WITH bill_by_agent AS (
  SELECT
    b.day AS collection_day,
    b.agent_id,
    b.rent_request_id,
    b.expected_ugx::numeric AS expected_ugx
  FROM public.agent_expected_day_plans b
),
rec_by_agent AS (
  SELECT
    (c.created_at AT TIME ZONE 'Africa/Kampala')::date AS collection_day,
    c.agent_id,
    c.rent_request_id,
    SUM(c.amount)::numeric AS paid_ugx
  FROM public.agent_collections c
  WHERE c.reversed_at IS NULL
    AND (c.notes IS NULL OR c.notes NOT ILIKE '%[REVERSED:%')
    AND c.amount > 0
  GROUP BY (c.created_at AT TIME ZONE 'Africa/Kampala')::date, c.agent_id, c.rent_request_id
),
merged AS (
  SELECT
    COALESCE(b.collection_day, r.collection_day) AS collection_day,
    COALESCE(b.agent_id, r.agent_id) AS agent_id,
    b.rent_request_id AS billed_plan_id,
    COALESCE(b.expected_ugx, 0)::numeric AS expected_ugx,
    CASE WHEN b.rent_request_id IS NOT NULL THEN COALESCE(r.paid_ugx, 0) ELSE 0 END::numeric AS on_schedule_ugx,
    CASE WHEN b.rent_request_id IS NULL THEN COALESCE(r.paid_ugx, 0) ELSE 0 END::numeric AS arrears_ugx,
    COALESCE(r.paid_ugx, 0)::numeric AS total_cash_ugx
  FROM bill_by_agent b
  FULL OUTER JOIN rec_by_agent r
    ON b.collection_day = r.collection_day
   AND b.rent_request_id = r.rent_request_id
)
SELECT
  m.collection_day,
  COALESCE(NULLIF(btrim(p.region), ''), 'Unspecified') AS region,
  COALESCE(NULLIF(btrim(p.district), ''), 'Unspecified') AS district,
  COUNT(DISTINCT m.agent_id)::integer AS active_agents_count,
  COUNT(m.billed_plan_id)::integer AS plans_billed_count,
  COALESCE(SUM(m.expected_ugx), 0)::numeric AS expected_pinned_ugx,
  COALESCE(SUM(m.on_schedule_ugx), 0)::numeric AS collected_on_schedule_ugx,
  COALESCE(SUM(m.arrears_ugx), 0)::numeric AS collected_arrears_ugx,
  COALESCE(SUM(m.total_cash_ugx), 0)::numeric AS total_cash_collected_ugx,
  CASE
    WHEN COALESCE(SUM(m.expected_ugx), 0) > 0
      THEN ROUND((COALESCE(SUM(m.on_schedule_ugx), 0) / SUM(m.expected_ugx)) * 100.0, 1)
    ELSE 0::numeric
  END AS on_schedule_coverage_pct
FROM merged m
LEFT JOIN public.profiles p ON p.id = m.agent_id
WHERE m.collection_day IS NOT NULL
  AND public.zoe_ro_require_area('agents')
GROUP BY
  m.collection_day,
  COALESCE(NULLIF(btrim(p.region), ''), 'Unspecified'),
  COALESCE(NULLIF(btrim(p.district), ''), 'Unspecified');

COMMENT ON VIEW zoe_ro.agents_daily_collections_by_region IS
  'Daily agent collection performance grouped by collection_day, region, and district using pinned daily expectations (agent_expected_day_plans) and non-reversed receipts (agent_collections). Use this for: comparing districts/regions (e.g. Wakiso vs Mukono) on expected vs on-schedule vs arrears collections. Do not use this for: dividing total_cash_collected_ugx by expected_pinned_ugx.';

CREATE OR REPLACE VIEW zoe_ro.agents_house_listings_summary
WITH (security_invoker = true)
AS
SELECT
  COALESCE(NULLIF(btrim(hl.region), ''), 'Unspecified') AS region,
  COALESCE(NULLIF(btrim(hl.district), ''), 'Unspecified') AS district,
  COALESCE(hl.house_category, 'standard') AS house_category,
  COALESCE(hl.status, 'unknown') AS status,
  COALESCE(hl.service_center_status, 'pending') AS service_center_status,
  COALESCE(hl.verified, false) AS verified,
  COUNT(*)::integer AS listings_count,
  ROUND(AVG(hl.monthly_rent), 0)::numeric AS avg_monthly_rent_ugx,
  ROUND(AVG(hl.daily_rate), 0)::numeric AS avg_daily_rate_ugx
FROM public.house_listings hl
WHERE hl.is_hidden IS FALSE
  AND public.zoe_ro_require_area('agents')
GROUP BY
  COALESCE(NULLIF(btrim(hl.region), ''), 'Unspecified'),
  COALESCE(NULLIF(btrim(hl.district), ''), 'Unspecified'),
  COALESCE(hl.house_category, 'standard'),
  COALESCE(hl.status, 'unknown'),
  COALESCE(hl.service_center_status, 'pending'),
  COALESCE(hl.verified, false);

COMMENT ON VIEW zoe_ro.agents_house_listings_summary IS
  'Agent house listings grouped by region, district, house_category, status, service_center_status, and verification state (caretaker/LC1 phones and GPS coordinates omitted). Use this for: house listing supply and verification breakdowns by district or region. Do not use this for: Rent Plan repayment figures.';

-- === AREA 6: SUPPORTERS ===

CREATE OR REPLACE VIEW zoe_ro.supporters_portfolios_summary
WITH (security_invoker = true)
AS
SELECT
  COALESCE(ip.status, 'unknown') AS status,
  COALESCE(ip.roi_mode, 'standard') AS returns_mode,
  ip.duration_months,
  COALESCE(ip.display_currency, 'UGX') AS display_currency,
  COALESCE(ip.cfo_verified, false) AS cfo_verified,
  COALESCE(ip.auto_reinvest, false) AS auto_reinvest,
  COUNT(*)::integer AS portfolios_count,
  COALESCE(SUM(ip.investment_amount), 0)::numeric AS total_principal_ugx,
  COALESCE(SUM(ip.principal_allocated), 0)::numeric AS principal_allocated_ugx,
  COALESCE(SUM(ip.principal_unallocated), 0)::numeric AS principal_unallocated_ugx,
  COALESCE(SUM(ip.total_roi_earned), 0)::numeric AS total_returns_earned_ugx
FROM public.investor_portfolios ip
WHERE public.zoe_ro_require_area('supporters')
GROUP BY
  COALESCE(ip.status, 'unknown'),
  COALESCE(ip.roi_mode, 'standard'),
  ip.duration_months,
  COALESCE(ip.display_currency, 'UGX'),
  COALESCE(ip.cfo_verified, false),
  COALESCE(ip.auto_reinvest, false);

COMMENT ON VIEW zoe_ro.supporters_portfolios_summary IS
  'Supporter portfolios grouped by status, returns_mode, duration_months, cfo_verified, and auto_reinvest (bank accounts, mobile money numbers, PINs, and tokens omitted). Always say "Supporter" and "Returns". Use this for: Supporter portfolio principal, allocation, and Returns analysis. Do not use this for: individual Supporter bank/mobile money details.';

CREATE OR REPLACE VIEW zoe_ro.supporters_promissory_notes_summary
WITH (security_invoker = true)
AS
SELECT
  date_trunc('month', pn.recorded_on::timestamp)::date AS recorded_month,
  COALESCE(pn.status, 'unknown') AS status,
  COALESCE(pn.support_mode, 'standard') AS support_mode,
  COALESCE(pn.contribution_type, 'one_off') AS contribution_type,
  COALESCE(pn.follow_up_status, 'pending') AS follow_up_status,
  COUNT(*)::integer AS notes_count,
  COALESCE(SUM(pn.amount), 0)::numeric AS total_pledged_ugx,
  COALESCE(SUM(pn.total_collected), 0)::numeric AS total_collected_ugx,
  COALESCE(SUM(GREATEST(pn.amount - pn.total_collected, 0)), 0)::numeric AS outstanding_pledge_ugx
FROM public.promissory_notes pn
WHERE public.zoe_ro_require_area('supporters')
GROUP BY
  date_trunc('month', pn.recorded_on::timestamp)::date,
  COALESCE(pn.status, 'unknown'),
  COALESCE(pn.support_mode, 'standard'),
  COALESCE(pn.contribution_type, 'one_off'),
  COALESCE(pn.follow_up_status, 'pending');

COMMENT ON VIEW zoe_ro.supporters_promissory_notes_summary IS
  'Supporter promissory notes grouped by recorded_month, status, support_mode, contribution_type, and follow_up_status (phones, WhatsApp numbers, emails, and tokens omitted). Use this for: promissory note pledge fulfilment and pipeline analysis. Do not use this for: recognised company cash before collection.';

-- === AREA 7: TENANTS ===

CREATE OR REPLACE VIEW zoe_ro.tenants_rent_plans_by_city
WITH (security_invoker = true)
AS
SELECT
  COALESCE(NULLIF(btrim(rr.request_city), ''), 'Unspecified') AS request_city,
  COALESCE(rr.status, 'unknown') AS status,
  COALESCE(rr.tenancy_status, 'unknown') AS tenancy_status,
  COALESCE(rr.repayment_frequency, 'daily') AS repayment_frequency,
  COUNT(*)::integer AS plans_count,
  COALESCE(SUM(rr.rent_amount), 0)::numeric AS total_rent_ugx,
  COALESCE(SUM(rr.total_repayment), 0)::numeric AS total_repayment_ugx,
  COALESCE(SUM(rr.amount_repaid), 0)::numeric AS amount_repaid_ugx,
  COALESCE(SUM(GREATEST(rr.total_repayment - rr.amount_repaid, 0)), 0)::numeric AS outstanding_balance_ugx,
  ROUND(AVG(rr.duration_days), 0)::numeric AS avg_duration_days
FROM public.rent_requests rr
WHERE rr.status IS DISTINCT FROM 'deleted_by_agent'
  AND public.zoe_ro_require_area('tenants')
GROUP BY
  COALESCE(NULLIF(btrim(rr.request_city), ''), 'Unspecified'),
  COALESCE(rr.status, 'unknown'),
  COALESCE(rr.tenancy_status, 'unknown'),
  COALESCE(rr.repayment_frequency, 'daily');

COMMENT ON VIEW zoe_ro.tenants_rent_plans_by_city IS
  'Tenant Rent Plans grouped by request_city, status, tenancy_status, and repayment_frequency (tenant phones, NINs, and utility meters omitted). Use this for: city-level tenant Rent Plan volume and repayment progress. Do not use this for: daily pinned bill coverage (use operations_daily_collection_coverage instead).';

CREATE OR REPLACE VIEW zoe_ro.tenants_arrears_by_city
WITH (security_invoker = true)
AS
WITH plan_billed AS (
  SELECT
    b.rent_request_id,
    SUM(b.expected_ugx)::numeric AS billed_to_date_ugx
  FROM public.agent_expected_day_plans b
  WHERE b.day <= ((now() AT TIME ZONE 'Africa/Kampala')::date)
  GROUP BY b.rent_request_id
)
SELECT
  COALESCE(NULLIF(btrim(rr.request_city), ''), 'Unspecified') AS request_city,
  COUNT(*)::integer AS active_plans_count,
  COUNT(*) FILTER (WHERE GREATEST(COALESCE(pb.billed_to_date_ugx, 0) - COALESCE(rr.amount_repaid, 0), 0) > 0)::integer AS plans_with_arrears_count,
  COALESCE(SUM(COALESCE(pb.billed_to_date_ugx, 0)), 0)::numeric AS total_expected_to_date_ugx,
  COALESCE(SUM(COALESCE(rr.amount_repaid, 0)), 0)::numeric AS total_repaid_ugx,
  COALESCE(SUM(GREATEST(COALESCE(pb.billed_to_date_ugx, 0) - COALESCE(rr.amount_repaid, 0), 0)), 0)::numeric AS overdue_balance_ugx
FROM public.rent_requests rr
LEFT JOIN plan_billed pb ON pb.rent_request_id = rr.id
WHERE rr.status IN ('funded', 'disbursed', 'repaying', 'approved')
  AND public.zoe_ro_require_area('tenants')
GROUP BY COALESCE(NULLIF(btrim(rr.request_city), ''), 'Unspecified');

COMMENT ON VIEW zoe_ro.tenants_arrears_by_city IS
  'Tenant Rent Plan arrears grouped by request_city comparing cumulative pinned daily bills (agent_expected_day_plans) against amount_repaid on active plans. Use this for: city-level arrears concentration analysis. Do not use this for: certified AM-clock arrears ageing buckets (use get_tops_arrears_ageing when an exact ageing bucket report is asked).';

-- === AREA 8: LANDLORDS ===

CREATE OR REPLACE VIEW zoe_ro.landlords_registry_by_district
WITH (security_invoker = true)
AS
SELECT
  COALESCE(NULLIF(btrim(l.region), ''), 'Unspecified') AS region,
  COALESCE(NULLIF(btrim(l.district), ''), 'Unspecified') AS district,
  COALESCE(l.house_category, 'standard') AS house_category,
  COALESCE(l.verification_status, 'pending') AS verification_status,
  COALESCE(l.service_center_status, 'pending') AS service_center_status,
  COALESCE(l.is_occupied, false) AS is_occupied,
  COALESCE(l.ready_to_receive, false) AS ready_to_receive,
  COUNT(*)::integer AS landlords_count,
  COALESCE(SUM(COALESCE(l.number_of_houses, 1)), 0)::integer AS total_houses_count,
  COALESCE(SUM(COALESCE(l.number_of_rooms, 1)), 0)::integer AS total_rooms_count,
  ROUND(AVG(l.monthly_rent), 0)::numeric AS avg_monthly_rent_ugx,
  COALESCE(SUM(l.rent_balance_due), 0)::numeric AS total_rent_balance_due_ugx
FROM public.landlords l
WHERE public.zoe_ro_require_area('landlords')
GROUP BY
  COALESCE(NULLIF(btrim(l.region), ''), 'Unspecified'),
  COALESCE(NULLIF(btrim(l.district), ''), 'Unspecified'),
  COALESCE(l.house_category, 'standard'),
  COALESCE(l.verification_status, 'pending'),
  COALESCE(l.service_center_status, 'pending'),
  COALESCE(l.is_occupied, false),
  COALESCE(l.ready_to_receive, false);

COMMENT ON VIEW zoe_ro.landlords_registry_by_district IS
  'Registered landlords grouped by region, district, house_category, verification_status, service_center_status, occupancy, and readiness (omits landlord phones, bank accounts, mobile money numbers, TINs, and verification PINs). Use this for: landlord registration, verification, and property capacity analysis by district. Do not use this for: payout phone number lookups.';

CREATE OR REPLACE VIEW zoe_ro.landlords_payouts_summary
WITH (security_invoker = true)
AS
SELECT
  (COALESCE(lp.disbursed_at, lp.created_at) AT TIME ZONE 'Africa/Kampala')::date AS payout_day,
  COALESCE(lp.status, 'unknown') AS status,
  COALESCE(lp.mobile_money_provider, 'unknown') AS mobile_money_provider,
  COALESCE(lp.gps_match, false) AS gps_match,
  COUNT(*)::integer AS payouts_count,
  COALESCE(SUM(lp.amount), 0)::numeric AS total_payout_ugx
FROM public.landlord_payouts lp
WHERE public.zoe_ro_require_area('landlords')
GROUP BY
  (COALESCE(lp.disbursed_at, lp.created_at) AT TIME ZONE 'Africa/Kampala')::date,
  COALESCE(lp.status, 'unknown'),
  COALESCE(lp.mobile_money_provider, 'unknown'),
  COALESCE(lp.gps_match, false);

COMMENT ON VIEW zoe_ro.landlords_payouts_summary IS
  'Landlord payouts grouped by payout_day, status, mobile_money_provider, and gps_match (omits landlord_phone and transaction references). Use this for: daily landlord payout volume and status analysis. Do not use this for: principal-vs-float comparison (use get_lops_principal_recovered for certified principal comparison).';

-- Explicit grants on all 18 `zoe_ro` views: SELECT to authenticated ONLY
REVOKE ALL ON ALL TABLES IN SCHEMA zoe_ro FROM PUBLIC, anon, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA zoe_ro TO authenticated;

REVOKE ALL ON TABLE zoe_ro.finance_treasury_cash_position FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.finance_treasury_cash_position TO authenticated;

REVOKE ALL ON TABLE zoe_ro.finance_receivables_and_payables FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.finance_receivables_and_payables TO authenticated;

REVOKE ALL ON TABLE zoe_ro.finance_requisitions_summary FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.finance_requisitions_summary TO authenticated;

REVOKE ALL ON TABLE zoe_ro.finance_budget_cycles FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.finance_budget_cycles TO authenticated;

REVOKE ALL ON TABLE zoe_ro.operations_daily_collection_coverage FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.operations_daily_collection_coverage TO authenticated;

REVOKE ALL ON TABLE zoe_ro.operations_rent_plans_by_stage FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.operations_rent_plans_by_stage TO authenticated;

REVOKE ALL ON TABLE zoe_ro.calling_daily_attempts_summary FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.calling_daily_attempts_summary TO authenticated;

REVOKE ALL ON TABLE zoe_ro.calling_pipeline_awareness_summary FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.calling_pipeline_awareness_summary TO authenticated;

REVOKE ALL ON TABLE zoe_ro.hr_department_headcount FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.hr_department_headcount TO authenticated;

REVOKE ALL ON TABLE zoe_ro.hr_contracts_overview FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.hr_contracts_overview TO authenticated;

REVOKE ALL ON TABLE zoe_ro.agents_daily_collections_by_region FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.agents_daily_collections_by_region TO authenticated;

REVOKE ALL ON TABLE zoe_ro.agents_house_listings_summary FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.agents_house_listings_summary TO authenticated;

REVOKE ALL ON TABLE zoe_ro.supporters_portfolios_summary FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.supporters_portfolios_summary TO authenticated;

REVOKE ALL ON TABLE zoe_ro.supporters_promissory_notes_summary FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.supporters_promissory_notes_summary TO authenticated;

REVOKE ALL ON TABLE zoe_ro.tenants_rent_plans_by_city FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.tenants_rent_plans_by_city TO authenticated;

REVOKE ALL ON TABLE zoe_ro.tenants_arrears_by_city FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.tenants_arrears_by_city TO authenticated;

REVOKE ALL ON TABLE zoe_ro.landlords_registry_by_district FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.landlords_registry_by_district TO authenticated;

REVOKE ALL ON TABLE zoe_ro.landlords_payouts_summary FROM PUBLIC, anon, service_role;
GRANT SELECT ON TABLE zoe_ro.landlords_payouts_summary TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Data Catalog Table (`public.staff_assistant_data_catalog`) &
--    Catalog Reader (`public.assistant_staff_data_catalog` / `public.get_data_catalog`)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_data_catalog (
  view_name       text PRIMARY KEY,
  role_area       text NOT NULL
                  CONSTRAINT staff_assistant_data_catalog_area_chk
                  CHECK (role_area IN (
                    'finance', 'operations', 'calling', 'hr',
                    'agents', 'supporters', 'tenants', 'landlords'
                  )),
  requires_aal2   boolean NOT NULL DEFAULT false,
  title           text NOT NULL,
  description     text NOT NULL,
  use_for         text NOT NULL,
  do_not_use_for  text NOT NULL,
  official_source text NOT NULL,
  columns         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_data_catalog IS
  'Metadata catalog of approved read-only zoe_ro.* views, role areas, column descriptions, and "use this for / do not use this for" guidance for Zoe''s Analyst lane.';

ALTER TABLE public.staff_assistant_data_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_data_catalog;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_data_catalog
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS staff_assistant_data_catalog_select_authorized ON public.staff_assistant_data_catalog;
CREATE POLICY staff_assistant_data_catalog_select_authorized
  ON public.staff_assistant_data_catalog
  FOR SELECT TO authenticated
  USING (
    (SELECT public.staff_assistant_has_access())
    AND (SELECT public.zoe_ro_area_allowed(role_area))
  );

REVOKE ALL ON TABLE public.staff_assistant_data_catalog FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.staff_assistant_data_catalog TO authenticated;
GRANT ALL ON TABLE public.staff_assistant_data_catalog TO service_role;

INSERT INTO public.staff_assistant_data_catalog (
  view_name, role_area, requires_aal2, title, description, use_for, do_not_use_for, official_source, columns
)
VALUES
  (
    'zoe_ro.finance_treasury_cash_position',
    'finance',
    true,
    'Treasury Cash Position (Official)',
    'Live company treasury cash position built on get_treasury_cash_position(now()). Reports A1 Cash & Bank + A5 Cash in Transit as spendable treasury cash, and A2 Agent Float separately.',
    'Checking available platform treasury cash (A1 + A5) vs agent float (A2).',
    'Never sum general_ledger or wallets directly for cash position; never add A2 agent float into spendable treasury cash.',
    'get_treasury_cash_position',
    '[
      {"name":"as_of_date","type":"date","description":"Kampala date of the snapshot"},
      {"name":"total_available_cash_ugx","type":"numeric","description":"Spendable treasury cash in UGX (A1 + A5)"},
      {"name":"a1_cash_and_bank_ugx","type":"numeric","description":"Account A1 Cash and Bank Balances in UGX"},
      {"name":"a5_cash_in_transit_ugx","type":"numeric","description":"Account A5 Cash in Transit in UGX"},
      {"name":"a2_agent_float_ugx","type":"numeric","description":"Account A2 Cash at Hand — Float held by agents in UGX"},
      {"name":"official_source","type":"text","description":"Authoritative function name"}
    ]'::jsonb
  ),
  (
    'zoe_ro.finance_receivables_and_payables',
    'finance',
    true,
    'Company Receivables and Payables Totals',
    'Authoritative Rent Plan receivables (A3) and company payables from get_receivables_total() and get_payables_total().',
    'Comparing total company Rent Plan receivables against landlord and Supporter payables.',
    'Do not include agent lending (agents'' own money) or uneligible merchandise plans.',
    'get_receivables_total + get_payables_total',
    '[
      {"name":"as_of_date","type":"date","description":"Kampala snapshot date"},
      {"name":"total_receivables_ugx","type":"numeric","description":"Total Rent Plan receivables in UGX"},
      {"name":"active_rent_plans_count","type":"integer","description":"Number of active Rent Plans in receivables"},
      {"name":"overdue_receivables_ugx","type":"numeric","description":"Overdue portion of Rent Plan receivables in UGX"},
      {"name":"total_payables_ugx","type":"numeric","description":"Total company payables in UGX"},
      {"name":"landlord_payables_ugx","type":"numeric","description":"Landlord rent payables in UGX"},
      {"name":"supporter_returns_payable_ugx","type":"numeric","description":"Supporter Returns payable in UGX"}
    ]'::jsonb
  ),
  (
    'zoe_ro.finance_requisitions_summary',
    'finance',
    true,
    'Staff Requisitions Summary',
    'Internal staff requisitions with department, category, approval stage, and UGX requested/approved amounts (PII omitted).',
    'Filtering or grouping requisitions by department, category, approval stage, or date range.',
    'Do not treat uncredited requisitions as paid cash expenses.',
    'staff_requisitions',
    '[
      {"name":"requisition_code","type":"text","description":"Human requisition reference code"},
      {"name":"title","type":"text","description":"Requisition title"},
      {"name":"department_key","type":"text","description":"Department key"},
      {"name":"category","type":"text","description":"Expense category"},
      {"name":"request_kind","type":"text","description":"Requisition kind"},
      {"name":"stage","type":"text","description":"Current approval stage"},
      {"name":"final_stage","type":"text","description":"Required final approval stage"},
      {"name":"requested_amount_ugx","type":"numeric","description":"Requested amount in UGX"},
      {"name":"approved_amount_ugx","type":"numeric","description":"Approved amount in UGX"},
      {"name":"wallet_credit_status","type":"text","description":"Disbursement credit status"},
      {"name":"created_date","type":"date","description":"Kampala date created"},
      {"name":"decided_date","type":"date","description":"Kampala date decided"}
    ]'::jsonb
  ),
  (
    'zoe_ro.finance_budget_cycles',
    'finance',
    true,
    'Company Budget Cycles',
    'Budget call cycles, financial years, periods, and statuses from budget_calls.',
    'Listing budget periods and statuses.',
    'Do not use for revised line-item amounts (use get_cfo_budget_revised_position for certified line items).',
    'budget_calls',
    '[
      {"name":"cycle_title","type":"text","description":"Budget cycle title"},
      {"name":"financial_year","type":"text","description":"Financial year label"},
      {"name":"period_type","type":"text","description":"Period granularity"},
      {"name":"period_start","type":"date","description":"Cycle start date"},
      {"name":"period_end","type":"date","description":"Cycle end date"},
      {"name":"status","type":"text","description":"Cycle status"},
      {"name":"deadline_date","type":"date","description":"Submission deadline date"}
    ]'::jsonb
  ),
  (
    'zoe_ro.operations_daily_collection_coverage',
    'operations',
    false,
    'Daily Rent Plan Collection Coverage (Expected vs Collected)',
    'Joins the 00:05 EAT pinned daily bill (agent_expected_day_plans) to non-reversed receipts (agent_collections) on (collection_day, rent_request_id) per welile-expected-vs-collected.',
    'Comparing expected pinned bills, on-schedule collections, capped collections, arrears collected, and true on-schedule coverage % by day.',
    'Never divide total_cash_collected_ugx by expected_pinned_ugx (that mixes older arrears into today''s bill and overstates coverage ~2x).',
    'agent_expected_day_plans + agent_collections',
    '[
      {"name":"collection_day","type":"date","description":"Kampala date of the bill and collection"},
      {"name":"plans_billed_count","type":"integer","description":"Number of Rent Plans pinned on that day''s bill"},
      {"name":"expected_pinned_ugx","type":"numeric","description":"Pinned daily expected UGX from agent_expected_day_plans"},
      {"name":"collected_on_schedule_ugx","type":"numeric","description":"UGX collected on that day against plans billed that day"},
      {"name":"collected_capped_ugx","type":"numeric","description":"UGX collected on schedule capped at LEAST(paid, expected) per plan"},
      {"name":"collected_arrears_ugx","type":"numeric","description":"UGX collected on that day for older unbilled arrears"},
      {"name":"total_cash_collected_ugx","type":"numeric","description":"Total non-reversed cash collected on that day (on-schedule + arrears)"},
      {"name":"true_on_schedule_coverage_pct","type":"numeric","description":"On-schedule coverage percentage (collected_on_schedule_ugx / expected_pinned_ugx * 100)"},
      {"name":"capped_coverage_pct","type":"numeric","description":"Capped coverage percentage (collected_capped_ugx / expected_pinned_ugx * 100)"}
    ]'::jsonb
  ),
  (
    'zoe_ro.operations_rent_plans_by_stage',
    'operations',
    false,
    'Rent Plans by Stage, City, and House Category',
    'Aggregated Rent Plans from rent_requests grouped by stage, tenancy_status, request_city, and house_category.',
    'Cross-tabulating Rent Plan counts, rent value, repaid UGX, and outstanding UGX by stage and city.',
    'Do not use for daily pinned collection coverage.',
    'rent_requests',
    '[
      {"name":"stage","type":"text","description":"Rent Plan pipeline stage"},
      {"name":"tenancy_status","type":"text","description":"Tenancy lifecycle status"},
      {"name":"request_city","type":"text","description":"City/area of the Rent Plan"},
      {"name":"house_category","type":"text","description":"House category"},
      {"name":"plans_count","type":"integer","description":"Count of Rent Plans"},
      {"name":"total_rent_ugx","type":"numeric","description":"Sum of principal rent_amount in UGX"},
      {"name":"total_access_fee_ugx","type":"numeric","description":"Sum of access_fee in UGX"},
      {"name":"total_repayment_ugx","type":"numeric","description":"Sum of total_repayment in UGX"},
      {"name":"total_repaid_ugx","type":"numeric","description":"Sum of amount_repaid in UGX"},
      {"name":"outstanding_ugx","type":"numeric","description":"Sum of remaining repayment in UGX"},
      {"name":"avg_daily_repayment_ugx","type":"numeric","description":"Average daily repayment in UGX"}
    ]'::jsonb
  ),
  (
    'zoe_ro.calling_daily_attempts_summary',
    'calling',
    false,
    'Calling Center Daily Attempts & Outcomes',
    'Daily Calling Center call attempts from cc_call_attempts (excluding voided rows), grouped by call_day, source_center, channel, outcome, and is_answered.',
    'Analysing daily or custom-range Calling Center volumes, answer rates, and outcomes.',
    'Do not use for individual callee phone numbers (omitted for privacy).',
    'cc_call_attempts',
    '[
      {"name":"call_day","type":"date","description":"Kampala date of the call attempt"},
      {"name":"source_center","type":"text","description":"Calling Center queue source"},
      {"name":"channel","type":"text","description":"Call channel"},
      {"name":"outcome","type":"text","description":"Recorded attempt outcome"},
      {"name":"is_answered","type":"boolean","description":"True when outcome = engaged"},
      {"name":"attempts_count","type":"integer","description":"Number of call attempts"},
      {"name":"distinct_callers_count","type":"integer","description":"Number of distinct calling officers"}
    ]'::jsonb
  ),
  (
    'zoe_ro.calling_pipeline_awareness_summary',
    'calling',
    false,
    'Rent Plan Pipeline Awareness Calls Summary',
    'Daily awareness calls from rent_pipeline_awareness_calls grouped by call_day, caller_team, pipeline_stage, subject_type, call_result, and landlord_consent.',
    'Checking awareness call reach and landlord consent across pipeline stages.',
    'Never treat awareness calls as payout approvals (awareness calls never affect approvals).',
    'rent_pipeline_awareness_calls',
    '[
      {"name":"call_day","type":"date","description":"Kampala date of the awareness call"},
      {"name":"caller_team","type":"text","description":"Calling team"},
      {"name":"pipeline_stage","type":"text","description":"Rent Plan pipeline stage at call time"},
      {"name":"subject_type","type":"text","description":"Subject type (tenant or landlord)"},
      {"name":"call_result","type":"text","description":"Call outcome"},
      {"name":"landlord_consent","type":"text","description":"Recorded landlord consent status"},
      {"name":"calls_count","type":"integer","description":"Number of awareness calls"}
    ]'::jsonb
  ),
  (
    'zoe_ro.hr_department_headcount',
    'hr',
    true,
    'HR Department Headcount & Positions',
    'Active staff count, primary assignments count, and active positions count per HR department.',
    'Comparing active staff headcount and positions across departments.',
    'Do not use for payroll UGX cost (use get_hr_payroll_cost_by_department for certified payroll costs).',
    'hr_departments + hr_positions + hr_assignments + hr_staff',
    '[
      {"name":"department_key","type":"text","description":"Department key"},
      {"name":"department_name","type":"text","description":"Department display name"},
      {"name":"measurement_mode","type":"text","description":"HR measurement mode"},
      {"name":"active_staff_count","type":"integer","description":"Count of active staff assigned to the department"},
      {"name":"primary_assignments_count","type":"integer","description":"Count of primary staff assignments"},
      {"name":"positions_count","type":"integer","description":"Count of active positions in the department"}
    ]'::jsonb
  ),
  (
    'zoe_ro.hr_contracts_overview',
    'hr',
    true,
    'HR Contracts Overview',
    'HR contracts grouped by contract_type, signature_status, currency, start_date, end_date, and days_to_expiry.',
    'Analysing contract counts, signature statuses, and upcoming expiry windows.',
    'Do not use for individual staff personal phone/NIN lookups.',
    'hr_contracts',
    '[
      {"name":"contract_type","type":"text","description":"Contract type"},
      {"name":"signature_status","type":"text","description":"Signature status"},
      {"name":"currency","type":"text","description":"Contract currency"},
      {"name":"start_date","type":"date","description":"Contract start date"},
      {"name":"end_date","type":"date","description":"Contract end date"},
      {"name":"days_to_expiry","type":"integer","description":"Days remaining until end_date"},
      {"name":"contracts_count","type":"integer","description":"Number of contracts in group"},
      {"name":"total_value_ugx","type":"numeric","description":"Sum of contract value_amount"}
    ]'::jsonb
  ),
  (
    'zoe_ro.agents_daily_collections_by_region',
    'agents',
    false,
    'Agent Daily Collections by Region and District',
    'Daily agent collection performance grouped by collection_day, region, and district using pinned daily expectations (agent_expected_day_plans) and non-reversed receipts (agent_collections).',
    'Comparing regions or districts (e.g. Wakiso vs Mukono) on expected pinned bills, on-schedule collections, arrears collections, and active agents.',
    'Do not divide total_cash_collected_ugx by expected_pinned_ugx; use on_schedule_coverage_pct.',
    'agent_expected_day_plans + agent_collections + profiles',
    '[
      {"name":"collection_day","type":"date","description":"Kampala collection date"},
      {"name":"region","type":"text","description":"Agent region"},
      {"name":"district","type":"text","description":"Agent district"},
      {"name":"active_agents_count","type":"integer","description":"Distinct agents with bills or collections on that day"},
      {"name":"plans_billed_count","type":"integer","description":"Number of Rent Plans billed on that day"},
      {"name":"expected_pinned_ugx","type":"numeric","description":"Pinned expected UGX for that region/district"},
      {"name":"collected_on_schedule_ugx","type":"numeric","description":"UGX collected on schedule against that day''s pinned bill"},
      {"name":"collected_arrears_ugx","type":"numeric","description":"UGX collected for older arrears"},
      {"name":"total_cash_collected_ugx","type":"numeric","description":"Total non-reversed cash collected in UGX"},
      {"name":"on_schedule_coverage_pct","type":"numeric","description":"On-schedule coverage percentage"}
    ]'::jsonb
  ),
  (
    'zoe_ro.agents_house_listings_summary',
    'agents',
    false,
    'Agent House Listings Summary by Region & District',
    'House listings from house_listings grouped by region, district, house_category, status, service_center_status, and verified flag.',
    'Comparing house listing inventory, verification rates, and average monthly rent across regions and districts.',
    'Do not use for active Rent Plan counts (use operations_rent_plans_by_stage).',
    'house_listings',
    '[
      {"name":"region","type":"text","description":"Listing region"},
      {"name":"district","type":"text","description":"Listing district"},
      {"name":"house_category","type":"text","description":"House category"},
      {"name":"status","type":"text","description":"Listing availability status"},
      {"name":"service_center_status","type":"text","description":"Service Centre review status"},
      {"name":"verified","type":"boolean","description":"Whether the house listing is verified"},
      {"name":"listings_count","type":"integer","description":"Number of house listings"},
      {"name":"avg_monthly_rent_ugx","type":"numeric","description":"Average monthly rent in UGX"},
      {"name":"avg_daily_rate_ugx","type":"numeric","description":"Average daily rate in UGX"}
    ]'::jsonb
  ),
  (
    'zoe_ro.supporters_portfolios_summary',
    'supporters',
    true,
    'Supporter Portfolios & Returns Summary',
    'Supporter portfolios grouped by status, returns_mode, duration_months, cfo_verified, and auto_reinvest (PII and account numbers omitted).',
    'Analysing Supporter portfolio principal, allocated vs unallocated principal, and total Returns earned.',
    'Never use banned terms (always say Supporter and Returns). Do not use for individual payout bank numbers.',
    'investor_portfolios',
    '[
      {"name":"status","type":"text","description":"Portfolio status"},
      {"name":"returns_mode","type":"text","description":"Supporter Returns payout mode"},
      {"name":"duration_months","type":"integer","description":"Portfolio duration in months"},
      {"name":"display_currency","type":"text","description":"Display currency"},
      {"name":"cfo_verified","type":"boolean","description":"Whether verified by CFO"},
      {"name":"auto_reinvest","type":"boolean","description":"Whether auto-reinvest is enabled"},
      {"name":"portfolios_count","type":"integer","description":"Number of Supporter portfolios"},
      {"name":"total_principal_ugx","type":"numeric","description":"Total Supporter principal in UGX"},
      {"name":"principal_allocated_ugx","type":"numeric","description":"Allocated Supporter principal in UGX"},
      {"name":"principal_unallocated_ugx","type":"numeric","description":"Unallocated Supporter principal in UGX"},
      {"name":"total_returns_earned_ugx","type":"numeric","description":"Total Supporter Returns earned in UGX"}
    ]'::jsonb
  ),
  (
    'zoe_ro.supporters_promissory_notes_summary',
    'supporters',
    true,
    'Supporter Promissory Notes Summary',
    'Supporter promissory notes grouped by recorded_month, status, support_mode, contribution_type, and follow_up_status.',
    'Tracking pledged vs collected promissory note UGX by month and status.',
    'Do not count uncollected pledges as treasury cash.',
    'promissory_notes',
    '[
      {"name":"recorded_month","type":"date","description":"Month the promissory note was recorded"},
      {"name":"status","type":"text","description":"Promissory note status"},
      {"name":"support_mode","type":"text","description":"Support mode"},
      {"name":"contribution_type","type":"text","description":"Contribution type"},
      {"name":"follow_up_status","type":"text","description":"Follow-up status"},
      {"name":"notes_count","type":"integer","description":"Number of promissory notes"},
      {"name":"total_pledged_ugx","type":"numeric","description":"Total pledged amount in UGX"},
      {"name":"total_collected_ugx","type":"numeric","description":"Total collected amount in UGX"},
      {"name":"outstanding_pledge_ugx","type":"numeric","description":"Remaining uncollected pledge in UGX"}
    ]'::jsonb
  ),
  (
    'zoe_ro.tenants_rent_plans_by_city',
    'tenants',
    false,
    'Tenant Rent Plans by City and Status',
    'Tenant Rent Plans from rent_requests grouped by request_city, status, tenancy_status, and repayment_frequency.',
    'Comparing tenant Rent Plan counts, rent value, repaid UGX, and outstanding balances across cities.',
    'Do not use for individual tenant phone or NIN lookups.',
    'rent_requests',
    '[
      {"name":"request_city","type":"text","description":"Tenant request city/area"},
      {"name":"status","type":"text","description":"Rent Plan status"},
      {"name":"tenancy_status","type":"text","description":"Tenancy status"},
      {"name":"repayment_frequency","type":"text","description":"Repayment frequency (daily/weekly/monthly)"},
      {"name":"plans_count","type":"integer","description":"Number of Rent Plans"},
      {"name":"total_rent_ugx","type":"numeric","description":"Total rent amount in UGX"},
      {"name":"total_repayment_ugx","type":"numeric","description":"Total scheduled repayment in UGX"},
      {"name":"amount_repaid_ugx","type":"numeric","description":"Amount repaid so far in UGX"},
      {"name":"outstanding_balance_ugx","type":"numeric","description":"Outstanding balance in UGX"},
      {"name":"avg_duration_days","type":"numeric","description":"Average plan duration in days"}
    ]'::jsonb
  ),
  (
    'zoe_ro.tenants_arrears_by_city',
    'tenants',
    false,
    'Tenant Arrears by City',
    'Active tenant Rent Plans compared against cumulative pinned daily bills (agent_expected_day_plans) by request_city.',
    'Comparing city-level arrears balances and counts of plans with arrears.',
    'Prefer get_tops_arrears_ageing when the user asks for the certified AM-clock arrears ageing buckets.',
    'rent_requests + agent_expected_day_plans',
    '[
      {"name":"request_city","type":"text","description":"Tenant request city/area"},
      {"name":"active_plans_count","type":"integer","description":"Active Rent Plans in city"},
      {"name":"plans_with_arrears_count","type":"integer","description":"Active Rent Plans currently behind pinned schedule"},
      {"name":"total_expected_to_date_ugx","type":"numeric","description":"Cumulative pinned expected UGX to date"},
      {"name":"total_repaid_ugx","type":"numeric","description":"Cumulative amount repaid in UGX"},
      {"name":"overdue_balance_ugx","type":"numeric","description":"Overdue balance in UGX"}
    ]'::jsonb
  ),
  (
    'zoe_ro.landlords_registry_by_district',
    'landlords',
    false,
    'Landlords Registry by Region and District',
    'Registered landlords from landlords grouped by region, district, house_category, verification_status, service_center_status, occupancy, and readiness.',
    'Comparing landlord counts, houses, rooms, verification status, and rent balance due across districts.',
    'Do not use for individual landlord phone numbers or bank/mobile-money payout numbers.',
    'landlords',
    '[
      {"name":"region","type":"text","description":"Landlord region"},
      {"name":"district","type":"text","description":"Landlord district"},
      {"name":"house_category","type":"text","description":"Property house category"},
      {"name":"verification_status","type":"text","description":"Landlord verification status"},
      {"name":"service_center_status","type":"text","description":"Service Centre status"},
      {"name":"is_occupied","type":"boolean","description":"Whether property is occupied"},
      {"name":"ready_to_receive","type":"boolean","description":"Whether landlord is ready to receive payouts"},
      {"name":"landlords_count","type":"integer","description":"Number of landlords"},
      {"name":"total_houses_count","type":"integer","description":"Total houses count"},
      {"name":"total_rooms_count","type":"integer","description":"Total rooms count"},
      {"name":"avg_monthly_rent_ugx","type":"numeric","description":"Average monthly rent in UGX"},
      {"name":"total_rent_balance_due_ugx","type":"numeric","description":"Total rent balance due in UGX"}
    ]'::jsonb
  ),
  (
    'zoe_ro.landlords_payouts_summary',
    'landlords',
    false,
    'Landlord Payouts Summary by Day and Status',
    'Landlord payouts from landlord_payouts grouped by payout_day, status, mobile_money_provider, and gps_match.',
    'Analysing daily landlord payout counts and UGX totals by status or provider.',
    'Prefer get_lops_principal_recovered for the certified float-vs-principal comparison.',
    'landlord_payouts',
    '[
      {"name":"payout_day","type":"date","description":"Kampala payout date"},
      {"name":"status","type":"text","description":"Payout status"},
      {"name":"mobile_money_provider","type":"text","description":"Mobile money provider"},
      {"name":"gps_match","type":"boolean","description":"Whether agent GPS matched property GPS"},
      {"name":"payouts_count","type":"integer","description":"Number of payouts"},
      {"name":"total_payout_ugx","type":"numeric","description":"Total payout amount in UGX"}
    ]'::jsonb
  )
ON CONFLICT (view_name) DO UPDATE
SET
  role_area = EXCLUDED.role_area,
  requires_aal2 = EXCLUDED.requires_aal2,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  use_for = EXCLUDED.use_for,
  do_not_use_for = EXCLUDED.do_not_use_for,
  official_source = EXCLUDED.official_source,
  columns = EXCLUDED.columns;

-- Read-only catalog tool RPC: `assistant_staff_data_catalog(p_area)`
CREATE OR REPLACE FUNCTION public.assistant_staff_data_catalog(
  p_area text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_area text := lower(btrim(COALESCE(p_area, 'all')));
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_views jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() OR NOT (
    public.can_view_staff_reports(v_uid) OR public.can_view_finance_reports(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorized: staff assistant report access required for get_data_catalog.'
      USING ERRCODE = '42501';
  END IF;

  IF v_area <> '' AND v_area <> 'all' THEN
    IF NOT public.zoe_ro_area_allowed(v_area) THEN
      RAISE EXCEPTION 'Not authorized for data catalog area "%".', v_area
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'view_name', c.view_name,
        'role_area', c.role_area,
        'requires_aal2', c.requires_aal2,
        'title', c.title,
        'description', c.description,
        'use_for', c.use_for,
        'do_not_use_for', c.do_not_use_for,
        'official_source', c.official_source,
        'columns', c.columns
      )
      ORDER BY c.role_area, c.view_name
    ),
    '[]'::jsonb
  )
  INTO v_views
  FROM public.staff_assistant_data_catalog c
  WHERE (v_area = '' OR v_area = 'all' OR c.role_area = v_area)
    AND public.zoe_ro_area_allowed(c.role_area);

  RETURN jsonb_build_object(
    'ad_hoc', true,
    'certification', 'Ad hoc, not certified',
    'source', 'staff_assistant_data_catalog (zoe_ro Read-Only View Catalog)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'area_filter', CASE WHEN v_area = '' THEN 'all' ELSE v_area END,
      'timezone', 'Africa/Kampala'
    ),
    'view_count', jsonb_array_length(v_views),
    'views', v_views
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.assistant_staff_data_catalog(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_data_catalog(text) TO authenticated;

-- Alias `public.get_data_catalog(p_area)` delegating to `assistant_staff_data_catalog(p_area)`
CREATE OR REPLACE FUNCTION public.get_data_catalog(
  p_area text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT public.assistant_staff_data_catalog(p_area);
$function$;

REVOKE ALL ON FUNCTION public.get_data_catalog(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_data_catalog(text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Append-Only Query Log Table (`public.staff_assistant_queries`)
--    Logs caller, question, SQL, row count, and duration.
--    Locked down: RLS enabled, `mfa_required_for_staff` restrictive policy,
--    `SELECT` only for `authenticated` (no user UPDATE or DELETE), plus an
--    append-only trigger that refuses UPDATE and DELETE.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_queries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  question      text NOT NULL DEFAULT '',
  sql_text      text NOT NULL,
  executed_sql  text NOT NULL,
  role_areas    text[] NOT NULL DEFAULT ARRAY[]::text[],
  row_count     integer NOT NULL DEFAULT 0 CHECK (row_count >= 0 AND row_count <= 500),
  truncated     boolean NOT NULL DEFAULT false,
  duration_ms   integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  status        text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'refused', 'error')),
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_queries IS
  'Append-only audit log of every ad-hoc Analyst query run through Zoe (caller, question, SQL, row count, duration, status). Users cannot update or delete rows.';

CREATE INDEX IF NOT EXISTS idx_staff_assistant_queries_user_created
  ON public.staff_assistant_queries (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_queries_created
  ON public.staff_assistant_queries (created_at DESC);

CREATE OR REPLACE FUNCTION public.trg_guard_staff_assistant_queries_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RAISE EXCEPTION 'staff_assistant_queries is append-only: % is not permitted.', TG_OP
    USING ERRCODE = '42501';
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_guard_staff_assistant_queries_append_only() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_staff_assistant_queries_append_only ON public.staff_assistant_queries;
CREATE TRIGGER trg_staff_assistant_queries_append_only
  BEFORE UPDATE OR DELETE ON public.staff_assistant_queries
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_guard_staff_assistant_queries_append_only();

ALTER TABLE public.staff_assistant_queries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_queries;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_queries
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS staff_assistant_queries_select_own_or_admin ON public.staff_assistant_queries;
CREATE POLICY staff_assistant_queries_select_own_or_admin
  ON public.staff_assistant_queries
  FOR SELECT TO authenticated
  USING (
    (user_id = (SELECT auth.uid()) AND (SELECT public.staff_assistant_has_access()))
    OR (SELECT public._has_enabled_role(
      (SELECT auth.uid()),
      ARRAY['cfo', 'ceo', 'coo', 'cto', 'super_admin']
    ))
  );

REVOKE ALL ON TABLE public.staff_assistant_queries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.staff_assistant_queries TO authenticated;
GRANT SELECT, INSERT ON TABLE public.staff_assistant_queries TO service_role;

CREATE OR REPLACE FUNCTION public.staff_assistant_log_query(
  p_question text,
  p_sql text,
  p_executed_sql text,
  p_role_areas text[],
  p_row_count integer,
  p_truncated boolean,
  p_duration_ms integer,
  p_status text DEFAULT 'ok',
  p_error_message text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized to log staff_assistant_queries'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM set_config('transaction_read_only', 'off', true);
    INSERT INTO public.staff_assistant_queries (
      user_id,
      question,
      sql_text,
      executed_sql,
      role_areas,
      row_count,
      truncated,
      duration_ms,
      status,
      error_message
    )
    VALUES (
      v_uid,
      left(btrim(COALESCE(p_question, '')), 1000),
      left(btrim(COALESCE(p_sql, '')), 4000),
      left(btrim(COALESCE(p_executed_sql, p_sql, '')), 4500),
      COALESCE(p_role_areas, ARRAY[]::text[]),
      LEAST(GREATEST(COALESCE(p_row_count, 0), 0), 500),
      COALESCE(p_truncated, false),
      GREATEST(COALESCE(p_duration_ms, 0), 0),
      CASE WHEN p_status IN ('ok', 'refused', 'error') THEN p_status ELSE 'ok' END,
      left(btrim(COALESCE(p_error_message, '')), 500)
    )
    RETURNING id INTO v_id;
    PERFORM set_config('transaction_read_only', 'on', true);
  EXCEPTION
    WHEN read_only_sql_transaction OR OTHERS THEN
      v_id := NULL;
  END;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_log_query(text, text, text, text[], integer, boolean, integer, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_log_query(text, text, text, text[], integer, boolean, integer, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Deterministic SQL Firewall (`public.zoe_ro_validate_query`) &
--    Analyst Query Runner (`public.assistant_staff_run_query`)
-- -----------------------------------------------------------------------------
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
  v_match text[];
  v_fn_name text;
  v_rel_token text;
  v_view_area text;
  v_requires_aal2 boolean := false;
  v_allowed_functions constant text[] := ARRAY[
    'count', 'sum', 'avg', 'min', 'max', 'array_agg', 'string_agg', 'bool_and', 'bool_or', 'every',
    'coalesce', 'nullif', 'greatest', 'least', 'abs', 'round', 'ceil', 'ceiling', 'floor', 'trunc', 'sign', 'mod', 'power', 'sqrt',
    'lower', 'upper', 'initcap', 'btrim', 'trim', 'ltrim', 'rtrim', 'left', 'right', 'length', 'char_length', 'substr', 'substring', 'replace', 'concat', 'concat_ws', 'split_part', 'strpos', 'position',
    'date_trunc', 'date_part', 'extract', 'age', 'to_char', 'to_date', 'now', 'current_date', 'current_timestamp', 'make_date', 'make_interval', 'justify_days', 'justify_hours', 'justify_interval',
    'row_number', 'rank', 'dense_rank', 'ntile', 'lag', 'lead', 'first_value', 'last_value',
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

  -- Reject control characters
  IF v_raw ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RAISE EXCEPTION 'Analyst query rejected: control characters are forbidden.'
      USING ERRCODE = '22023';
  END IF;

  -- Reject SQL comments (-- or /* */) that can hide statements or bypass token checks
  IF v_raw ~ '--' OR v_raw ~ '/\*' OR v_raw ~ '\*/' THEN
    RAISE EXCEPTION 'Analyst query rejected: SQL comments (-- or /* */) are not allowed.'
      USING ERRCODE = '22023';
  END IF;

  -- Strip at most one trailing semicolon, then reject any remaining semicolon anywhere
  v_clean := regexp_replace(v_raw, ';\s*$', '');
  IF position(';' IN v_clean) > 0 THEN
    RAISE EXCEPTION 'Analyst query rejected: multiple statements or semicolon chaining are forbidden.'
      USING ERRCODE = '22023';
  END IF;

  -- Prompt injection & secret extraction defense inside SQL text
  IF v_clean ~* '(ignore\s+(all\s+|any\s+)?(previous|prior)\s+instructions|<UNTRUSTED_TOOL_DATA|SUPABASE_SERVICE_ROLE_KEY|LOVABLE_API_KEY|system\s+prompt|developer\s+mode|jailbreak)' THEN
    RAISE EXCEPTION 'Analyst query rejected: prompt injection or secret extraction pattern detected.'
      USING ERRCODE = '42501';
  END IF;

  -- Strip single-quoted string literals for structural SQL inspection
  v_no_literals := regexp_replace(v_clean, '''(?:''''|[^''])*''', '''''', 'g');
  v_lower := lower(btrim(v_no_literals));

  -- Must start with SELECT or WITH ... SELECT
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

  -- Reject write, DDL, session, locking, and administrative keywords
  IF v_lower ~ '\m(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|set|reset|show|discard|begin|commit|rollback|savepoint|release|lock|vacuum|analyze|cluster|reindex|explain|prepare|deallocate|execute|call|do|listen|notify|unlisten|load|import|security|owner|into)\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: write, DDL, COPY, SET, or administrative SQL keywords are forbidden.'
      USING ERRCODE = '42501';
  END IF;

  -- Reject locking clauses
  IF v_lower ~ '\mfor\s+(update|share|no\s+key\s+update|key\s+share)\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: row-locking clauses are forbidden.'
      USING ERRCODE = '42501';
  END IF;

  -- Reject sleep, dblink, file-system, and session functions explicitly
  IF v_lower ~ '\m(pg_sleep|pg_sleep_for|pg_sleep_until|dblink|dblink_exec|dblink_connect|lo_import|lo_export|lo_unlink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|set_config|current_setting|pg_advisory_lock|pg_try_advisory_lock|query_to_xml|table_to_xml|database_to_xml)\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: forbidden system, sleep, or network function.'
      USING ERRCODE = '42501';
  END IF;

  -- Reject PII or secret column names anywhere in the query
  IF v_lower ~ '\m(password|pin_hash|otp|secret|token|activation_token|portfolio_pin|national_id|nin|id_image_hash|selfie_image_hash|signup_device_fp|verification_pin_1|verification_pin_2|aware_payout_otp|aware_merchant_codes|unmasked_phone|raw_phone|account_number|mobile_money_number|subject_phone|caretaker_phone|lc1_chairperson_phone|whatsapp_number|phone_number)\M' THEN
    RAISE EXCEPTION 'Analyst query rejected: PII, phone, account number, or secret columns are forbidden.'
      USING ERRCODE = '42501';
  END IF;

  -- Reject cross joins, comma joins, and unconditional Cartesian joins (ON true / ON 1=1)
  IF v_lower ~ '\mcross\s+join\M'
     OR v_lower ~ '\mfrom\s+zoe_ro\.[a-z0-9_]+(?:\s+(?:as\s+)?[a-z0-9_]+)?\s*,'
     OR v_lower ~ '\mjoin\s+[^\n]+?\mon\s*\(?\s*(true|1\s*=\s*1)\s*\)?' THEN
    RAISE EXCEPTION 'Analyst query rejected: CROSS JOIN or unconstrained Cartesian join is forbidden.'
      USING ERRCODE = '22023';
  END IF;

  -- Reject references to any schema other than zoe_ro
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

  -- Inspect every FROM / JOIN target: must be a subquery `(`, a declared CTE, or `zoe_ro.<view>`
  FOR v_match IN
    SELECT regexp_matches(v_lower, '\m(?:from|join)\s+([a-z_][a-z0-9_.]*)', 'g')
  LOOP
    v_rel_token := v_match[1];
    -- Ignore EXTRACT(... FROM <identifier>) where the token immediately precedes `)`
    IF v_rel_token = ANY(v_cte_names) THEN
      CONTINUE;
    END IF;
    IF v_rel_token !~ '^zoe_ro\.[a-z0-9_]+$' THEN
      -- Check if this `from` belongs to `extract(... from ...)` or `trim(... from ...)`
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
    'role_areas', to_jsonb(v_ref_areas)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.zoe_ro_validate_query(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.zoe_ro_validate_query(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.assistant_staff_run_query(
  p_sql text,
  p_question text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, zoe_ro
SET statement_timeout = '5s'
SET default_transaction_read_only = on
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_started_at timestamptz := clock_timestamp();
  v_validation jsonb;
  v_clean_sql text;
  v_wrapped_sql text;
  v_areas text[] := ARRAY[]::text[];
  v_views text[] := ARRAY[]::text[];
  v_area text;
  v_fetched_count integer := 0;
  v_truncated boolean := false;
  v_rows jsonb := '[]'::jsonb;
  v_columns jsonb := '[]'::jsonb;
  v_duration_ms integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() OR NOT (
    public.can_view_staff_reports(v_uid) OR public.can_view_finance_reports(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required for assistant_staff_run_query.'
      USING ERRCODE = '42501';
  END IF;

  -- 1. Validate SQL structure, single SELECT, allow-listed functions, and zoe_ro objects
  v_validation := public.zoe_ro_validate_query(p_sql);
  v_clean_sql := v_validation ->> 'clean_sql';

  SELECT COALESCE(array_agg(val), ARRAY[]::text[])
    INTO v_areas
    FROM jsonb_array_elements_text(COALESCE(v_validation -> 'role_areas', '[]'::jsonb)) AS t(val);

  SELECT COALESCE(array_agg(val), ARRAY[]::text[])
    INTO v_views
    FROM jsonb_array_elements_text(COALESCE(v_validation -> 'views', '[]'::jsonb)) AS t(val);

  -- 2. Verify caller role area permissions (and require_staff_aal2() for finance/hr/supporters)
  FOREACH v_area IN ARRAY v_areas LOOP
    PERFORM public.zoe_ro_require_area(v_area);
  END LOOP;

  -- 3. Wrap with hard 500-row cap (fetching up to 501 to detect truncation)
  v_wrapped_sql := format(
    'SELECT count(*)::integer AS fetched_count, ' ||
    '(count(*) > 500) AS is_truncated, ' ||
    'COALESCE(jsonb_agg(sub._row_json) FILTER (WHERE sub._rn <= 500), ''[]''::jsonb) AS rows_json ' ||
    'FROM (SELECT to_jsonb(_zoe_q) AS _row_json, row_number() OVER () AS _rn FROM (%s) AS _zoe_q LIMIT 501) sub',
    v_clean_sql
  );

  -- 4. Execute inside the function-header 5-second timeout + default_transaction_read_only = on guard
  EXECUTE v_wrapped_sql INTO v_fetched_count, v_truncated, v_rows;

  -- 5. Sanitize any phone/NIN-like JSON keys as defense-in-depth
  v_rows := public.staff_assistant_sanitize_jsonb(COALESCE(v_rows, '[]'::jsonb), false, 500);

  IF jsonb_array_length(v_rows) > 0 AND jsonb_typeof(v_rows -> 0) = 'object' THEN
    SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb)
      INTO v_columns
      FROM jsonb_object_keys(v_rows -> 0) AS k;
  END IF;

  v_duration_ms := GREATEST(
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000)::integer,
    0
  );

  -- 6. Best-effort log to append-only staff_assistant_queries (when in read-write tx)
  PERFORM public.staff_assistant_log_query(
    p_question,
    v_clean_sql,
    format('SELECT * FROM (%s) AS _zoe_q LIMIT 500', v_clean_sql),
    v_areas,
    LEAST(COALESCE(v_fetched_count, 0), 500),
    COALESCE(v_truncated, false),
    v_duration_ms,
    'ok',
    NULL
  );

  RETURN jsonb_build_object(
    'ad_hoc', true,
    'certification', 'Ad hoc, not certified',
    'source', format('zoe_ro (%s) — Ad hoc, not certified', array_to_string(v_views, ', ')),
    'period', jsonb_build_object(
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'role_areas', to_jsonb(v_areas),
    'views_used', to_jsonb(v_views),
    'sql', v_clean_sql,
    'executed_sql', format('SELECT * FROM (%s) AS _zoe_q LIMIT 500', v_clean_sql),
    'columns', v_columns,
    'row_count', jsonb_array_length(v_rows),
    'row_limit', 500,
    'truncated', COALESCE(v_truncated, false),
    'duration_ms', v_duration_ms,
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.assistant_staff_run_query(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_run_query(text, text) TO authenticated;

-- Extend `staff_assistant_can_user_read_report` for `assistant_staff_data_catalog`
CREATE OR REPLACE FUNCTION public.staff_assistant_can_user_read_report(
  p_user_id uuid,
  p_report_rpc text
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

  IF v_rpc IN (
    'assistant_staff_my_profile',
    'assistant_staff_my_payslips',
    'assistant_staff_my_tasks_and_attendance',
    'assistant_staff_my_work_logs',
    'assistant_staff_my_tickets',
    'assistant_staff_my_requisitions',
    'assistant_staff_my_concerns',
    'assistant_staff_my_canteen',
    'assistant_staff_my_calls',
    'assistant_staff_welile_glossary',
    'assistant_staff_get_glossary',
    'assistant_staff_data_catalog'
  ) THEN
    RETURN true;
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

REVOKE ALL ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text) TO authenticated, service_role;

COMMIT;
