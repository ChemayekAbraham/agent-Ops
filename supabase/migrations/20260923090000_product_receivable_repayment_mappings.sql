-- PREPARED FOR REVIEW — NOT APPLIED, NOT DEPLOYED, NOT PUSHED.
--
-- Step 1 of the repayment-routing fix: create the five product-specific
-- receivable mappings so future relief and recognition reach the correct family
-- instead of A4.
--
-- MAPPINGS ONLY. This migration adds no ledger row, changes no function, and
-- touches no wallet, repayment or operational record. None of the five
-- categories carries a leg today (verified), so nothing reports differently
-- until the posting functions are changed in a separate, reviewed step.
--
-- WHY MAPPINGS MUST LAND FIRST
-- `agent_advance_repayment` is ALREADY in ledger_category_allowlist() but has
-- NO mapping. A function emitting it today would insert successfully and then
-- map to nothing -- the relief would vanish from the balance sheet entirely,
-- which is worse than landing in A4. Mapping before emission closes that hole.
--
-- EXISTING MAPPINGS ARE NOT TOUCHED
--   agent_repayment    platform -> A4  (7,090 legs)  unchanged
--   advance_repayment  wallet   -> A4  (2 legs)      unchanged
-- Because these are NEW categories, no historical leg changes meaning and no
-- balance moves. Re-pointing agent_repayment instead would have shifted
-- UGX 34,437,168 between accounts with no journal entry at all.
--
-- debit_when = 'cash_out' on every row, matching the existing agent_repayment
-- mapping, so a platform cash_in leg CREDITS the receivable (relieves it).
--
-- A14 and credit_draw_repayment: mapping only. No function posts credit-draw
-- repayments today -- the 16
-- existing legs carry null idempotency keys, i.e. they were posted by hand.
-- No repayment path is invented here.

BEGIN;

-- ALLOWLIST FIRST.
-- trg_validate_ledger_category is enabled and treasury_controls.strict_mode has
-- been true since 2026-04-09, so validate_ledger_category() RAISES on any
-- category outside ledger_category_allowlist(). Mapping alone is NOT enough:
-- mapping and allowlisting are two independent gates and a leg must pass both.
-- Without this, every merchandise recovery, merchandise payment and smartphone
-- disbursement would start failing the moment 20260923100000 landed.
--
-- agent_advance_repayment is already in ledger_category_allowlist_base(), so
-- only the other four are added. The twelve existing extension entries are
-- reproduced verbatim -- this replaces the function, it does not append to it.
-- strict_mode is NOT touched.
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
    'smartphone_advance_receivable'
  ]::text[];
$function$;

DO $m$
DECLARE
  v_before int;
  v_added  int;
  v_bad    int;
BEGIN
  SELECT count(*) INTO v_before FROM public.ledger_account_map;

  INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, debit_when, account_code)
  VALUES
    ('platform', 'agent_advance_repayment',        NULL, 'cash_out', 'A10'),
    ('platform', 'merchandise_recovery_repayment', NULL, 'cash_out', 'A12'),
    ('platform', 'bike_recovery_repayment',        NULL, 'cash_out', 'A13'),
    ('platform', 'credit_draw_repayment',          NULL, 'cash_out', 'A14'),
    ('platform', 'smartphone_advance_receivable',  NULL, 'cash_out', 'A12')
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_added = ROW_COUNT;

  -- 1: the five categories must carry no ledger legs. If any does, something
  -- already emits it and this mapping would restate live history.
  SELECT count(*) INTO v_bad FROM public.general_ledger
   WHERE category IN ('agent_advance_repayment','smartphone_advance_receivable',
                      'merchandise_recovery_repayment','bike_recovery_repayment',
                      'credit_draw_repayment');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % legs already exist for the new categories', v_bad
      USING ERRCODE = '55000';
  END IF;

  -- 2: the existing mappings must be exactly as they were.
  SELECT count(*) INTO v_bad FROM public.ledger_account_map
   WHERE (category='agent_repayment'   AND NOT (ledger_scope='platform' AND account_code='A4' AND debit_when='cash_out'))
      OR (category='advance_repayment' AND NOT (ledger_scope='wallet'   AND account_code='A4' AND debit_when='cash_in'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: existing agent_repayment/advance_repayment mapping altered' USING ERRCODE='55000';
  END IF;

  -- 3: every new category must resolve to a real account in the catalogue.
  SELECT count(*) INTO v_bad
    FROM public.ledger_account_map m
    LEFT JOIN public.ledger_account_catalog c ON c.code = m.account_code
   WHERE m.category IN ('agent_advance_repayment','smartphone_advance_receivable',
                        'merchandise_recovery_repayment','bike_recovery_repayment',
                        'credit_draw_repayment')
     AND c.code IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % new mapping(s) point at an account not in ledger_account_catalog', v_bad
      USING ERRCODE = '55000';
  END IF;

  -- 4: exactly five mappings present afterwards, one per category.
  SELECT count(*) INTO v_bad FROM public.ledger_account_map
   WHERE category IN ('agent_advance_repayment','smartphone_advance_receivable',
                      'merchandise_recovery_repayment','bike_recovery_repayment',
                      'credit_draw_repayment');
  IF v_bad <> 5 THEN
    RAISE EXCEPTION 'ABORT: expected 5 new mappings, found %', v_bad USING ERRCODE='55000';
  END IF;

  -- 5: every new category must ALSO be in the allowlist. strict_mode is on, so
  -- a mapped-but-unlisted category is rejected at insert by
  -- trg_validate_ledger_category. Both gates must pass before any function
  -- emits these categories.
  SELECT count(*) INTO v_bad
    FROM (VALUES ('agent_advance_repayment'),('smartphone_advance_receivable'),
                 ('merchandise_recovery_repayment'),('bike_recovery_repayment'),
                 ('credit_draw_repayment')) AS c(cat)
   WHERE NOT (c.cat = ANY (public.ledger_category_allowlist()));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % new category(ies) missing from ledger_category_allowlist()', v_bad
      USING ERRCODE = '55000';
  END IF;

  -- 6: the twelve pre-existing extension entries must survive the replacement.
  SELECT count(*) INTO v_bad
    FROM (VALUES ('agent_advance_receivable_opening'),('agent_access_fee_receivable_opening'),
                 ('merchandise_recovery_receivable_opening'),('bike_recovery_receivable_opening'),
                 ('credit_draw_receivable_opening'),('merchandise_credit_sale_receivable_opening'),
                 ('service_centre_advance_receivable_opening'),('service_centre_receivable_opening'),
                 ('tenant_service_charge_receivable_opening'),('business_advance_receivable_opening'),
                 ('rent_plan_receivable_restatement'),('receivable_restatement_equity')) AS c(cat)
   WHERE NOT (c.cat = ANY (public.ledger_category_allowlist()));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % pre-existing allowlist entry(ies) lost in the replacement', v_bad
      USING ERRCODE = '55000';
  END IF;

  RAISE NOTICE 'Added % mapping row(s) (was %, now %); 5/5 mapped and allowlisted. No ledger row posted.',
    v_added, v_before, v_before + v_added;
END
$m$;

COMMIT;

-- EXPECTED EFFECT ON APPLY
--   ledger_account_map: +5 rows.
--   ledger_category_allowlist(): +4 entries (agent_advance_repayment was already
--     in _base()); the twelve existing extension entries are preserved and asserted.
--   strict_mode: UNTOUCHED.
--   general_ledger, wallets, rent_requests, agent_collections, repayments: UNCHANGED.
--   Reported balances: UNCHANGED (no leg uses these categories yet).
