-- Blocker 4: register the thirteen approved Agent Advance categories with the
-- strict-mode category allowlist.
--
-- `validate_ledger_category()` raises 'Category "%" is not in the locked
-- allowlist' on every general_ledger insert when
-- treasury_controls.strict_mode is enabled. strict_mode IS enabled and STAYS
-- enabled -- the allowlist is extended, the control is not weakened.
--
-- All thirteen were verified absent before this change: none is in the
-- allowlist, none has a ledger_account_map row, and none appears anywhere in
-- general_ledger. There are no name collisions; in particular
-- `agent_advance_registration_fee_collected` is deliberately distinct from the
-- existing `registration_fee_collected`, which maps to R1 rather than A20.
--
-- This migration ONLY permits the names. It creates no account, no mapping and
-- no posting: A10/A11/A20/L8 wiring lands with the forward accounting matrix.
-- Nothing can post under these categories until that mapping exists, and
-- mapped_balance_mode stays on 'log' until then.
--
-- The base list is untouched: this replaces only the wrapper that appends to
-- public.ledger_category_allowlist_base().

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT public.ledger_category_allowlist_base() || ARRAY[
    -- existing extension entries, unchanged
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

    -- Agent Advance forward accounting matrix, approved 2026-09-26.
    -- Origination and top-up (replaces the rent_disbursement exception)
    'agent_advance_disbursement',
    -- Fees charged at origination
    'agent_advance_access_fee_charged',
    'agent_advance_registration_fee_charged',
    'agent_advance_fee_revenue',
    -- Overdue penalty: receivable now, income on collection
    'agent_advance_penalty_accrued',
    'agent_advance_penalty_unearned',
    -- Repayment allocation, pro rata across the receivable components
    'agent_advance_access_fee_collected',
    'agent_advance_registration_fee_collected',
    -- Write-off
    'agent_advance_written_off',
    'agent_advance_access_fee_written_off',
    'agent_advance_registration_fee_written_off',
    -- Reversal on settlement of the clawback
    'agent_advance_reversed',
    'agent_advance_clawback'
  ]::text[];
$function$;
