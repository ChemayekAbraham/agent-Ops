-- Agent Advance waterfall: external-funding counterpart categories.
--
-- Stage B. Reference data only: three allowlist entries and three mappings.
--
-- INERT ON PURPOSE
-- ----------------
-- These three exist for the EXTERNAL funding route (CFO cash/bank receipt),
-- which is currently dead code and is deliberately NOT being revived here:
-- `agent_advance_receipt_bank` and `agent_advance_repayment_external` are both
-- absent from ledger_category_allowlist() and have zero legs, so with
-- strict_mode = true that branch of cfo_record_advance_payment raises on its
-- second leg and posts nothing. Reviving it is a separate decision about
-- external cash receipts. Until then nothing can post under the three
-- categories below.
--
-- WHY THE DIRECTION FLIPS, AND WHY ONLY THREE
-- -------------------------------------------
-- create_ledger_transaction enforces raw cash_in = cash_out, so the receivable
-- legs must mirror the funding leg:
--
--   wallet route    cash_in  = receivables P, R3 credit L
--                   cash_out = funding P (L1), L8 debit L
--   external route  cash_in  = funding P (A1/A5), R3 credit L
--                   cash_out = receivables P, L8 debit L
--
-- Both balance at P + L a side. The L8 debit is cash_out and the R3 credit is
-- cash_in on BOTH routes -- they belong to the late-fee release pair and never
-- mirror the funding leg -- so L8 and R3 need no external variant. Only the
-- receivable legs flip, and A10's principal variant
-- (`agent_advance_repayment_external`) already exists. Hence three, not four.
--
-- debit_when = 'cash_in' throughout, the mirror of the wallet-route categories,
-- so a leg posted cash_out CREDITS the receivable.
--
-- VERIFIED READ-ONLY BEFORE WRITING THIS
--   * None of the three exists in ledger_account_map or the allowlist.
--   * A11, A20 and A10 all exist; their wallet-route counterparts are
--     agent_advance_access_fee_collected, agent_advance_registration_fee_collected
--     and agent_advance_penalty_accrued, all debit_when = 'cash_out'.
--   * Direction rules read directly from ledger_account_map, not inferred.
--
-- Fingerprint of ledger_category_allowlist() before this change:
--   a9a456bc05235da006f7fd14b0b55a46   (157 entries)

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
    'agent_advance_late_fee_income',
    'agent_advance_access_fee_collected_external',
    'agent_advance_registration_fee_collected_external',
    'agent_advance_penalty_accrued_external'
  ]::text[];
$function$;

INSERT INTO public.ledger_account_map
  (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
VALUES
  ('platform', 'agent_advance_access_fee_collected_external', NULL, 'A11', 'cash_in',
   'Access-fee share of an EXTERNALLY funded repayment (CFO cash/bank receipt). Posted cash_out so it credits A11, mirroring agent_advance_access_fee_collected on the wallet route. Inert until the external receipt branch is revived.'),
  ('platform', 'agent_advance_registration_fee_collected_external', NULL, 'A20', 'cash_in',
   'Registration-fee share of an EXTERNALLY funded repayment. Posted cash_out so it credits A20. Inert until the external receipt branch is revived.'),
  ('platform', 'agent_advance_penalty_accrued_external', NULL, 'A10', 'cash_in',
   'Late-fee de-recognition on an EXTERNALLY funded repayment: credits A10 for the capitalised late fee being settled. Posted cash_out. The matching L8 release and R3 income legs need no external variant. Inert until the external receipt branch is revived.')
ON CONFLICT DO NOTHING;
