-- Salary advances to employees: recognise them as Loans and Advances to Employees (A27).
-- CFO decision 11 Nov 2026. Accounting rules only: this migration posts nothing and moves no money.
--
-- Why: four interest-free "settling-in" salary advances (UGX 7,000,000; hr_pay_advances) were paid in cash outside
-- the app by Benjamin Muhanguzi with company money and are recovered from monthly salaries (hr_pay_advance_recoveries).
-- Neither side ever reached the ledger: the payout was never booked, and hr-pay-release books only take-home pay as
-- salary cost, so each recovery (5,666,800 to date) vanished and salary expense is understated by that amount.
--
-- Rules (platform scope only; no wallet leg, no wallet or balance change):
--   salary_advance_disbursed         -> A27  DR when the leg is cash_in   (the employee owes the company)
--   salary_advance_cash_paid         -> A1   DR when cash_in; posted cash_out = CR A1 (company cash paid out)
--   salary_advance_recovery_expense  -> X1   DR when cash_out (the full salary is a cost; Payroll and staff costs)
--   salary_advance_recovered         -> A27  DR when cash_out; posted cash_in = CR A27 (advance recovered from salary)
-- None of these categories is a Money In category (_cfo_received_category_for returns null), so nothing is counted as
-- money received. A27's label is widened to cover salary advances; its Balance Sheet heading is already
-- "Loans and Advances to Employees".
--
-- The backdated postings are a separate, CFO-approved batch: docs/finance/corrections/2026-11-11_salary_advances.sql.
-- Rollback: supabase/rollbacks/20261115110000_salary_advances_staff_receivable.rollback.sql

UPDATE public.ledger_account_catalog
   SET label = 'Staff loans and salary advances receivable'
 WHERE code = 'A27' AND label = 'Staff loans receivable';

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
SELECT v.* FROM (VALUES
  ('platform', 'salary_advance_disbursed',        NULL::text, 'A27', 'cash_in',  'Salary advance paid to an employee: amount owed to the company (CFO 11 Nov 2026)'),
  ('platform', 'salary_advance_cash_paid',        NULL::text, 'A1',  'cash_in',  'Company cash paid out as a salary advance (posted cash_out = credit)'),
  ('platform', 'salary_advance_recovery_expense', NULL::text, 'X1',  'cash_out', 'Salary withheld to recover an advance is still salary cost'),
  ('platform', 'salary_advance_recovered',        NULL::text, 'A27', 'cash_out', 'Salary advance recovered from payroll (posted cash_in = credit)')
) AS v(ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
WHERE NOT EXISTS (SELECT 1 FROM public.ledger_account_map m
                  WHERE m.ledger_scope = v.ledger_scope AND m.category = v.category
                    AND m.wallet_bucket IS NOT DISTINCT FROM v.wallet_bucket);

-- Income statement: the recovered part of salary reports with the rest of payroll
INSERT INTO public.fin_pnl_lines (account_code, category, section, line_label, sort, flag) VALUES
  ('X1', 'salary_advance_recovery_expense', 'operating_expense', 'Payroll and staff costs', 310, NULL)
ON CONFLICT (account_code, category) DO NOTHING;

-- Allow the new categories (production definition of 11 Nov 2026, md5 8ec8a589…, reproduced verbatim; one entry added)
CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT (((public.ledger_category_allowlist_base() || ARRAY[
    'staff_loan_charge_collected',
    'agent_advance_receivable_opening',
    'agent_access_fee_receivable_opening',
    'merchandise_recovery_receivable_opening',
    'bike_recovery_receivable_opening',
    'credit_draw_receivable_opening',
    'merchandise_credit_sale_receivable_opening',
    'service_centre_advance_receivable_opening',
    'service_centre_receivable_opening',
    'tenant_service_charge_receivable_opening',
    'business_advance_receivable_opening',
    'rent_plan_receivable_restatement',
    'receivable_restatement_equity',
    'merchandise_recovery_repayment',
    'bike_recovery_repayment',
    'credit_draw_repayment',
    'smartphone_advance_receivable',
    'agent_advance_disbursement',
    'agent_advance_access_fee_charged',
    'agent_advance_registration_fee_charged',
    'agent_advance_fee_revenue',
    'agent_advance_penalty_accrued',
    'agent_advance_penalty_unearned',
    'agent_advance_access_fee_collected',
    'agent_advance_registration_fee_collected',
    'agent_advance_written_off',
    'agent_advance_access_fee_written_off',
    'agent_advance_registration_fee_written_off',
    'agent_advance_reversed',
    'agent_advance_clawback',
    'agent_advance_late_fee_income',
    'agent_advance_access_fee_collected_external',
    'agent_advance_registration_fee_collected_external',
    'agent_advance_penalty_accrued_external',
    -- Landlord Float Pool (20260929160000, 20260929180000, 20260929240000)
    'landlord_pool_reserve_self_support',
    'landlord_pool_reserve_company_managed',
    'landlord_pool_reserve_source',
    'landlord_pool_topup_self_support',
    'landlord_pool_topup_company_managed',
    'landlord_pool_compound_self_support',
    'landlord_pool_compound_company_managed',
    'landlord_pool_deploy_self_support',
    'landlord_pool_deploy_company_managed',
    'landlord_pool_deploy_target',
    'landlord_pool_return_self_support',
    'landlord_pool_return_company_managed',
    'landlord_pool_return_source',
    'landlord_pool_release_self_support',
    'landlord_pool_release_company_managed',
    'landlord_pool_release_target'
  ]::text[]) || ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
                       'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']::text[]) || ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',
                       'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income']::text[]
    -- 2026-11-04 (CFO, merchandise phase 3): merchandise sales revenue (R1); offset of the advance shown on an agent's
    -- wallet for a phone bought by the company (L1 memo, not money owed to the agent)
    || ARRAY['merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained']::text[]
    || ARRAY['agent_advance_memo_offset']::text[]
    -- 2026-11-10 (CFO draft): platform-only reversal of a float restatement loss booked in error (X6)
    || ARRAY['float_restatement_correction']::text[]) || ARRAY['welile_cover_fee']::text[]
    -- 2026-11-11 (CFO): salary advances to employees (A27 Loans and Advances to Employees)
    || ARRAY['salary_advance_disbursed', 'salary_advance_cash_paid', 'salary_advance_recovered', 'salary_advance_recovery_expense']::text[];
$function$
