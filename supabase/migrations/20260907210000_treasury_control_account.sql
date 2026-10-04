-- PHASE 1 (1/5): Platform Treasury control account — Landlord Flow.
--
-- WHY A NEW ACCOUNT
-- Every one of the 24 existing accounts was evaluated and rejected:
--   A1/A2/A5  physical cash — using them would DOUBLE-COUNT cash
--   A9/L9     suspense for unresolved postings — wrong semantics
--   L1        user wallet custody      L2  partner subscribed capital
--   L3/L5     destinations OF an allocation, not the control itself
--   L4        landlord obligation — must stay separate by requirement
--   L6        partner top-ups awaiting application
--   R1        revenue — Treasury is not revenue until it is allocated
--   E*/X*     equity / expense
-- No account represents "fee economics recognised but not yet allocated".
--
-- WHAT L7 IS ECONOMICALLY
-- A clearing/control account. Registration Fee and Access Fee economics are
-- CREDITED to L7 on recognition, then DEBITED out as they are allocated to
-- Partner Reward (L3), Agent Commission (L5) and Platform Net revenue (R1).
-- Fully allocated, L7 nets to zero. A residual credit balance means "Treasury
-- recognised but not yet allocated" — which is a real obligation-in-waiting,
-- so current_liability is the honest classification.
--
-- WHY IT IS NOT ADDITIONAL CASH
-- L7 is never debited or credited against a cash movement. Cash stays in
-- A1/A2/A5 and is untouched by this migration. L7 records the DESIGNATION of
-- fee economics already represented elsewhere (as an A3 receivable until the
-- tenant pays, then as cash). It carries a normal CREDIT balance. It must
-- never be added to a cash total.

INSERT INTO public.ledger_account_catalog (code, label, section, nature, sort_order)
VALUES ('L7', 'Platform Treasury Control — Landlord Flow', 'current_liability', 'liability',
        (SELECT COALESCE(MAX(sort_order),0)+1 FROM public.ledger_account_catalog WHERE section='current_liability'))
ON CONFLICT (code) DO NOTHING;

-- Mappings. Liability convention follows platform.cash_custody_payable -> L1
-- (debit_when 'cash_in', so a cash_out leg CREDITS the liability).
-- Revenue convention follows platform.registration_fee_collected -> R1
-- (debit_when 'cash_out', so a cash_in leg CREDITS revenue).
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes) VALUES
  ('platform','treasury_fee_recognised',   NULL,'L7','cash_in',
   'Registration/Access fee economics recognised into Platform Treasury. Post cash_out to CREDIT L7.'),
  ('platform','treasury_allocated',        NULL,'L7','cash_in',
   'Treasury relieved as it is allocated to L3/L5/R1. Post cash_in to DEBIT L7.'),
  ('bridge','fee_receivable_created',      NULL,'A3','cash_in',
   'Tenant receivable for the fee components of total_repayment. Post cash_in to DEBIT A3.'),
  ('platform','partner_reward_accrued',    NULL,'L3','cash_in',
   'Partner Reward obligation from Landlord Flow. Post cash_out to CREDIT L3. NOT POSTED until BD-2 resolves.'),
  ('platform','agent_commission_accrued',  NULL,'L5','cash_in',
   'Agent Commission obligation from Landlord Flow. Post cash_out to CREDIT L5. NOT POSTED until the waterfall is approved.'),
  ('platform','treasury_net_revenue',      NULL,'R1','cash_out',
   'Platform Net portion of the Access Fee. Post cash_in to CREDIT R1.')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket, '*')) DO UPDATE
  SET account_code = EXCLUDED.account_code,
      debit_when   = EXCLUDED.debit_when,
      notes        = EXCLUDED.notes;

-- Extend the strict-mode category allowlist with the six new categories.
DO $do$
DECLARE v_new text[] := ARRAY['treasury_fee_recognised','treasury_allocated','fee_receivable_created',
                              'partner_reward_accrued','agent_commission_accrued','treasury_net_revenue'];
        v_cur text[]; v_all text[];
BEGIN
  SELECT public.ledger_category_allowlist() INTO v_cur;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_all FROM unnest(v_cur || v_new) AS x;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.ledger_category_allowlist() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path TO ''public'' AS $f$ SELECT %L::text[] $f$',
    v_all);
END
$do$;
