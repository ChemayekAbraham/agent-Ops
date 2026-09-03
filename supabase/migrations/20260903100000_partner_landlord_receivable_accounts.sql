-- Part 1 of 2 — Chart of accounts and mappings for Partner and Landlord receivables.
-- BIS approved. This migration adds structure only; it posts no balances.
-- The dated backfill is migration 20260903100100.
--
-- ── Why these are not already on the balance sheet ──────────────────────────
--
-- get_statement_of_financial_position() is a trial balance over general_ledger.
-- promissory_notes and welile_homes_subscriptions never posted a receivable leg,
-- so the balances existed only in the operational sub-ledgers and were disclosed
-- as memo_sub_ledgers ("not recognised in the ledger totals"). Recognising them
-- means posting the missing legs, not adding sub-ledger sums to a total.
--
-- ── Accounts ────────────────────────────────────────────────────────────────
--
-- A6 and A7 are unused; the catalog holds A1-A5 and A9. Both are current assets,
-- consistent with A3 Rent Access Receivables and A4 Advances and Other
-- Receivables.
--
-- ── Debit / credit treatment ────────────────────────────────────────────────
--
-- The established pattern for recognising a receivable with no cash movement is
-- the `bridge` scope: bridge.rent_receivable_created -> A3, paired against a
-- wallet leg. Verified live - a rent recognition group is
--   bridge.rent_receivable_created (cash_in)      -> DEBIT  A3
--   wallet.agent_float_used_for_rent (cash_out)   -> CREDIT A2
-- one cash_in leg and one cash_out leg of equal size, so trg_enforce_ledger_
-- group_balance is satisfied. These mappings mirror that exactly.
--
--   Partner recognition   DR A7 / CR L2
--     bridge.partner_receivable_created      cash_in   -> DEBIT  A7
--     platform.partner_receivable_capital    cash_out  -> CREDIT L2
--   A promissory note is a subscription receivable: Welile gains the right to
--   receive cash, and simultaneously the obligation that the capital, once
--   received, belongs to the partner. No equity movement, no revenue, no plug.
--
--   Landlord recognition  DR A6 / CR L4
--     bridge.landlord_receivable_created     cash_in   -> DEBIT  A6
--     platform.landlord_receivable_obligation cash_out -> CREDIT L4
--   The outstanding balance is tenant rent that passes through to the landlord,
--   so recognising the receivable also recognises the landlord obligation. L4 is
--   currently nil, so nothing is double counted.
--
--   Collection            DR cash / CR receivable
--     platform.partner_receivable_collected  cash_out  -> CREDIT A7
--     platform.landlord_receivable_collected cash_out  -> CREDIT A6
--   Partner collections currently credit L2 via platform.partner_funding. Once
--   L2 is recognised up front, continuing to credit it on collection would
--   double count the liability, so collections must credit the receivable.
--   Landlord collections currently credit A3 via rent_repayment, which is the
--   tenant rent receivable and does not hold the Welile Homes balance.
--
--   Reversal / adjustment reuses the same categories with the opposite
--   direction, so a cancelled note reverses DR L2 / CR A7.
--
-- Every mapping below sets debit_when = 'cash_in'. Combined with the posted leg
-- direction above this yields the intended side in sofp_ledger_legs, which
-- resolves a leg as: CASE WHEN direction = debit_when THEN debit ELSE credit END.

INSERT INTO public.ledger_account_catalog (code, label, section, nature, sort_order)
VALUES
  ('A6', 'Landlord Product Receivables', 'current_asset', 'asset', 26),
  ('A7', 'Partner Product Receivables',  'current_asset', 'asset', 27)
ON CONFLICT (code) DO NOTHING;

-- ── Category allowlist ──────────────────────────────────────────────────────
--
-- treasury_controls.strict_mode is ON, so trg_validate_ledger_category rejects
-- any category outside ledger_category_allowlist(). The list is a literal array
-- inside that function; rather than restate all 106 entries (and risk dropping
-- one), the existing array is read back and unioned with the new categories.
-- Idempotent: re-running is a no-op because the union de-duplicates.

DO $do$
DECLARE
  v_new text[] := ARRAY[
    'partner_receivable_created',
    'partner_receivable_capital',
    'partner_receivable_collected',
    'landlord_receivable_created',
    'landlord_receivable_obligation',
    'landlord_receivable_collected'
  ];
  v_all text[];
BEGIN
  SELECT array_agg(c ORDER BY c) INTO v_all
  FROM (
    SELECT unnest(public.ledger_category_allowlist()) AS c
    UNION
    SELECT unnest(v_new)
  ) x;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.ledger_category_allowlist() '
    'RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path TO ''public'' '
    'AS $f$ SELECT %L::text[] $f$;', v_all);
END
$do$;

-- ── Account mappings ────────────────────────────────────────────────────────

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
VALUES
  ('bridge',   'partner_receivable_created',     NULL, 'A7', 'cash_in',
   'Recognition of a promissory note receivable. Posted cash_in so it debits A7. Counterpart credits L2.'),
  ('platform', 'partner_receivable_capital',     NULL, 'L2', 'cash_in',
   'Counterpart to partner_receivable_created. Posted cash_out so it credits L2 Partner Portfolios - Capital Held.'),
  ('platform', 'partner_receivable_collected',   NULL, 'A7', 'cash_out',
   'Settlement of a promissory note. The platform leg is posted cash_in (cash received) which, against debit_when cash_out, credits A7 and reduces the receivable — the same convention as rent_repayment and agent_repayment. Must be used instead of partner_funding, which credits L2 and would double count the liability.'),
  ('bridge',   'landlord_receivable_created',    NULL, 'A6', 'cash_in',
   'Recognition of a Welile Homes subscription receivable. Posted cash_in so it debits A6. Counterpart credits L4.'),
  ('platform', 'landlord_receivable_obligation', NULL, 'L4', 'cash_in',
   'Counterpart to landlord_receivable_created. Posted cash_out so it credits L4 Landlord Rent Payable.'),
  ('platform', 'landlord_receivable_collected',  NULL, 'A6', 'cash_out',
   'Settlement of a Welile Homes subscription. The platform leg is posted cash_in (cash received) which, against debit_when cash_out, credits A6 and reduces the receivable. Replaces rent_repayment on this path, which credits A3 and does not hold this receivable.')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket, '*')) DO UPDATE
  SET account_code = EXCLUDED.account_code,
      debit_when   = EXCLUDED.debit_when,
      notes        = EXCLUDED.notes;

-- ── Verification ────────────────────────────────────────────────────────────
--
--   SELECT code,label,section FROM ledger_account_catalog WHERE code IN ('A6','A7');
--   SELECT ledger_scope,category,account_code,debit_when FROM ledger_account_map
--    WHERE category LIKE '%receivable_%' ORDER BY 1,2;
--   SELECT public.validate_ledger_category('partner_receivable_created');  -- true
--
-- No balance changes from this migration: no general_ledger row is written, so
-- the balance sheet is identical before and after.
