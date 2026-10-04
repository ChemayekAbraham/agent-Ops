-- Agent Advance Late Fee: create R3 and the income category.
--
-- Stage A of the approved repayment-waterfall change. Reference data only:
-- a chart-of-accounts row, one allowlist entry and one mapping. Nothing posts
-- under `agent_advance_late_fee_income` until the repayment functions are
-- changed, which is a separate stage.
--
-- CFO decision of 2026-09-27: collected Late Fee is recognised as income in a
-- DEDICATED account, not folded into R2. R2 holds origination fee income
-- (access and registration fees, recognised when the advance is granted);
-- Late Fee is default income, recognised only when collected. Keeping them
-- apart is the whole reason R2 was split out of R1 in the first place.
--
-- APPROVED TREATMENT this supports
--   Accrual     DR A10 / CR L8          no wallet leg, no P&L
--   Collection  DR L8  / CR R3          release only what is actually collected
--
-- Terminology: agent-facing wording is "Late Fee", never "Penalty Interest".
-- The internal category names `agent_advance_penalty_accrued` and
-- `agent_advance_penalty_unearned` are left as they are -- they are already
-- live in `ledger_account_map` and `ledger_category_allowlist()`, they are not
-- shown to agents, and renaming them would be a breaking change to reference
-- data for no accounting benefit.
--
-- VERIFIED READ-ONLY BEFORE WRITING THIS
--   * R3 absent everywhere: 0 catalog rows, 0 mappings.
--   * Revenue section currently R1=10, R2=20, so sort_order 30 is free.
--   * No late-fee income category is allowlisted, so one is added here.
--   * Every other mapping the waterfall needs already exists and is
--     allowlisted: agent_advance_penalty_accrued -> A10,
--     agent_advance_penalty_unearned -> L8,
--     agent_advance_access_fee_collected -> A11,
--     agent_advance_registration_fee_collected -> A20,
--     agent_advance_repayment -> A10.
--
-- Convention: debit_when = 'cash_out', matching R1 and R2, so a leg posted
-- cash_in CREDITS the revenue account.
--
-- Fingerprint of ledger_category_allowlist() before this change:
--   fadb349714012e5e9516874b1fc9320e

-- ------------------------------------------------------------------ account
INSERT INTO public.ledger_account_catalog (code, label, nature, section, sort_order)
VALUES ('R3', 'Agent Advance Late Fee Income', 'revenue', 'revenue', 30)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------- allowlist
-- Unchanged except for the single appended entry, so strict_mode accepts the
-- new category.
CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT public.ledger_category_allowlist_base() || ARRAY[
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
    'agent_advance_late_fee_income'
  ]::text[];
$function$;

-- ------------------------------------------------------------------ mapping
INSERT INTO public.ledger_account_map
  (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
VALUES
  ('platform', 'agent_advance_late_fee_income', NULL, 'R3', 'cash_out',
   'Agent Advance Late Fee income, recognised only on collection by releasing L8. Posted cash_in so it credits R3. CFO decision 2026-09-27: a dedicated account, separate from R2 origination fee income, because Late Fee is default income earned on collection rather than at grant.')
ON CONFLICT DO NOTHING;
