-- Landlord Float Pool — accounts, mappings and allowlist (checklist steps 1–3).
--
-- Design: docs/LANDLORD_POOL_FUNDING_DESIGN.md
--
-- From the cutover, every new portfolio's principal is reserved into the
-- Landlord Float Pool, under one of two origins carried in the CATEGORY:
--
--   company_managed — no tenant (Rent Plan) and no house plan attached
--   self_support    — one or more tenants or house plans attached
--                     (house support = self_support + source_table
--                      'partner_supported_houses'; no category of its own)
--
-- This migration only makes the categories postable. Nothing posts to them
-- yet; the RPCs and callers ship in later migrations. It is additive: no
-- existing mapping row, account or allowlist entry changes.
--
-- Every group these categories form balances on BASE MAPPING alone
-- (all rows debit_when = cash_in):
--
--   reserve  pool cash_in  DR A21/A22   reserve_source cash_out  CR A1
--   deploy   pool cash_out CR A21/A22   rent_receivable_created (bridge,
--                                         existing) cash_in       DR A3
--   return   pool cash_in  DR A21/A22   return_source  cash_out  CR A5
--   release  pool cash_out CR A21/A22   release_target cash_in   DR A1
--
-- All legs are platform scope and MUST be posted with ledger_scope set
-- explicitly: auto_assign_ledger_scope() defaults unknown categories to
-- 'wallet', which would move a wallet balance.

-- ── 1. Accounts ────────────────────────────────────────────────────────────
INSERT INTO public.ledger_account_catalog (code, label, nature, section, sort_order)
VALUES
  ('A21', 'Landlord Float Pool — Self-Support',     'asset', 'current_asset', 11),
  ('A22', 'Landlord Float Pool — Company-Managed',  'asset', 'current_asset', 12)
ON CONFLICT (code) DO NOTHING;

-- ── 2. Mappings (bucket-agnostic, platform scope) ─────────────────────────
INSERT INTO public.ledger_account_map (ledger_scope, wallet_bucket, category, account_code, debit_when, notes)
VALUES
  ('platform', NULL, 'landlord_pool_reserve_self_support',     'A21', 'cash_in', 'Landlord Float Pool: self-support principal reserved on portfolio approval.'),
  ('platform', NULL, 'landlord_pool_reserve_company_managed',  'A22', 'cash_in', 'Landlord Float Pool: company-managed principal reserved on portfolio approval.'),
  ('platform', NULL, 'landlord_pool_reserve_source',           'A1',  'cash_in', 'Landlord Float Pool: free treasury cash leaving A1 into the pool (posted cash_out = CR A1).'),
  ('platform', NULL, 'landlord_pool_deploy_self_support',      'A21', 'cash_in', 'Landlord Float Pool: self-support money deployed to an agent landlord float (posted cash_out = CR A21); pairs with rent_receivable_created DR A3.'),
  ('platform', NULL, 'landlord_pool_deploy_company_managed',   'A22', 'cash_in', 'Landlord Float Pool: company-managed money deployed to an agent landlord float (posted cash_out = CR A22); pairs with rent_receivable_created DR A3.'),
  ('platform', NULL, 'landlord_pool_return_self_support',      'A21', 'cash_in', 'Landlord Float Pool: principal part of a tenant repayment returned to the self-support pool.'),
  ('platform', NULL, 'landlord_pool_return_company_managed',   'A22', 'cash_in', 'Landlord Float Pool: principal part of a tenant repayment returned to the company-managed pool.'),
  ('platform', NULL, 'landlord_pool_return_source',            'A5',  'cash_in', 'Landlord Float Pool: collected principal leaving cash in transit into the pool (posted cash_out = CR A5).'),
  ('platform', NULL, 'landlord_pool_release_self_support',     'A21', 'cash_in', 'Landlord Float Pool: undeployed self-support money released on maturity/redemption (posted cash_out = CR A21).'),
  ('platform', NULL, 'landlord_pool_release_company_managed',  'A22', 'cash_in', 'Landlord Float Pool: undeployed company-managed money released on maturity/redemption (posted cash_out = CR A22).'),
  ('platform', NULL, 'landlord_pool_release_target',           'A1',  'cash_in', 'Landlord Float Pool: released money returning to free treasury cash (DR A1).')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket, '*')) DO NOTHING;

-- ── 3. Allowlist ──────────────────────────────────────────────────────────
-- Replaced, not appended: every existing extra entry is reproduced verbatim
-- (live definition as at 2026-09-29), then the 11 pool categories.
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
    'agent_advance_penalty_accrued_external',
    -- Landlord Float Pool (20260929230700)
    'landlord_pool_reserve_self_support',
    'landlord_pool_reserve_company_managed',
    'landlord_pool_reserve_source',
    'landlord_pool_deploy_self_support',
    'landlord_pool_deploy_company_managed',
    'landlord_pool_return_self_support',
    'landlord_pool_return_company_managed',
    'landlord_pool_return_source',
    'landlord_pool_release_self_support',
    'landlord_pool_release_company_managed',
    'landlord_pool_release_target'
  ]::text[];
$function$;
