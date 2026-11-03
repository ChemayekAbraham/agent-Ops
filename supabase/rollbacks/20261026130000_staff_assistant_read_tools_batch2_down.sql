-- =============================================================================
-- Rollback: 20261026130000_staff_assistant_read_tools_batch2_down.sql
-- Purpose:  Drops the 20 Batch 2 assistant_staff_* read-only tool functions
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.assistant_staff_hr_payroll_cost_by_department(text);
DROP FUNCTION IF EXISTS public.assistant_staff_hr_contracts_and_birthdays(integer);
DROP FUNCTION IF EXISTS public.assistant_staff_hr_calling_detailed_report(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_ceo_growth_and_approvals(integer);
DROP FUNCTION IF EXISTS public.assistant_staff_coo_overview(integer, date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_fops_verification_and_requisitions(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_cfo_budget_revised_position();
DROP FUNCTION IF EXISTS public.assistant_staff_cfo_seven_day_expenses();
DROP FUNCTION IF EXISTS public.assistant_staff_cfo_receivables_and_payables(text, integer, date);
DROP FUNCTION IF EXISTS public.assistant_staff_cfo_money_flow_summary();
DROP FUNCTION IF EXISTS public.assistant_staff_cfo_treasury_cash_position(timestamptz);
DROP FUNCTION IF EXISTS public.assistant_staff_pso_cohort_performance(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_pops_search_supporters(text, integer);
DROP FUNCTION IF EXISTS public.assistant_staff_pops_report_overview(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_pops_pending_summary(date);
DROP FUNCTION IF EXISTS public.assistant_staff_aops_silent_collectors(integer, integer);
DROP FUNCTION IF EXISTS public.assistant_staff_aops_listing_quality_and_risk(date, date, integer);
DROP FUNCTION IF EXISTS public.assistant_staff_aops_metrics_agents(date, date, text, text, text, integer);
DROP FUNCTION IF EXISTS public.assistant_staff_aops_metrics_totals(date, date);
DROP FUNCTION IF EXISTS public.assistant_staff_aops_network_overview(date, date, numeric);

COMMIT;
