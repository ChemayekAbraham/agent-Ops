-- PREPARED FOR REVIEW — NOT APPLIED, NOT DEPLOYED, NOT PUSHED.
--
-- Step 2 of the repayment-routing fix: point the PLATFORM leg of each product
-- repayment at its own receivable family instead of A4.
--
-- REQUIRES 20260923090000 (the five mappings) TO BE APPLIED FIRST.
-- Asserted below: if a target category is unmapped this migration aborts,
-- because an unmapped leg vanishes from the balance sheet entirely -- worse
-- than landing in A4.
--
-- WHY A REGEX REWRITE RATHER THAN A FULL FUNCTION BODY
-- Each of these functions builds TWO legs with category 'agent_repayment':
--   wallet   leg -> recipient_type 'user'               (drives bucket routing)
--   platform leg -> recipient_type 'operational_wallet' (maps to A4)
-- Only the platform leg may change. Re-typing seven money-path function bodies
-- by hand risks a transcription error in exactly the code that caused the
-- 10 and 16 September incidents. Instead each function is read from the live
-- catalogue and rewritten by a context-anchored regex that can only match the
-- platform leg, with an assertion that EXACTLY ONE substitution occurred and
-- that the wallet leg is untouched. A mismatch aborts; it cannot half-apply.
--
-- SCOPE
--   * Platform leg category only.
--   * No wallet leg, wallet_bucket, recipient_type or wallet balance changes.
--   * No tenant repayment, amount_repaid, commission, schedule or operational
--     record changes.
--   * No historical ledger row is read for update, modified or deleted. The
--     7,090 existing agent_repayment legs keep their category and stay in A4.
--   * agent_purchase_merchandise and apply_layer_a_writedown are NOT changed:
--     the first posts merchandise_revenue on the platform side (its only
--     agent_repayment occurrence is the wallet leg), the second's occurrence is
--     inside a `category NOT IN (...)` filter, not a leg.
--
-- ROUTING
--   collect_due_agent_advance_installment  -> agent_advance_repayment      A10
--   sweep_agent_advance_recovery           -> agent_advance_repayment      A10
--   recover_agent_arrears_from_credit      -> agent_advance_repayment      A10
--   apply_roi_advance_recovery             -> agent_advance_repayment      A10
--   recover_merchandise_from_wallets       -> bike_recovery_repayment      A13
--                                             when item_name ILIKE '%bike%',
--                                             else merchandise_recovery_repayment A12
--   agent_pay_merchandise_plan             -> same bike/merchandise split
--   cfo_disburse_smartphone_order          -> smartphone_advance_receivable A12
--
-- cfo_disburse_smartphone_order is a RECOGNITION, not a repayment: its platform
-- leg is direction cash_out and DEBITS the receivable. Its anchor is therefore
-- 'ledger_scope','platform' rather than recipient_type, and its category is a
-- receivable category (debit_when cash_out) rather than a *_repayment one.

BEGIN;

DO $route$
DECLARE
  r            record;
  v_def        text;
  v_new        text;
  v_before     int;
  v_after      int;
  v_wallet_before int;
  v_wallet_after  int;
  v_changed    int := 0;
  -- name, replacement expression (SQL literal or CASE), anchor kind
  v_targets    text[][] := ARRAY[
    ARRAY['collect_due_agent_advance_installment', '''agent_advance_repayment''',  'operational'],
    ARRAY['sweep_agent_advance_recovery',          '''agent_advance_repayment''',  'operational'],
    ARRAY['recover_agent_arrears_from_credit',     '''agent_advance_repayment''',  'operational'],
    ARRAY['apply_roi_advance_recovery',            '''agent_advance_repayment''',  'operational'],
    ARRAY['recover_merchandise_from_wallets',      'CASE WHEN COALESCE(v_plan.item_name, '''') ILIKE ''%bike%'' THEN ''bike_recovery_repayment'' ELSE ''merchandise_recovery_repayment'' END', 'operational'],
    ARRAY['agent_pay_merchandise_plan',            'CASE WHEN COALESCE(v_plan.item_name, '''') ILIKE ''%bike%'' THEN ''bike_recovery_repayment'' ELSE ''merchandise_recovery_repayment'' END', 'operational'],
    ARRAY['cfo_disburse_smartphone_order',         '''smartphone_advance_receivable''', 'platform']
  ];
  i int;
BEGIN
  ------------------------------------------------------------------ preflight
  -- A leg must pass BOTH gates, which are enforced independently:
  --   1. ledger_account_map  -- an unmapped leg resolves to no account and
  --      disappears from the balance sheet entirely.
  --   2. ledger_category_allowlist() -- trg_validate_ledger_category RAISES on
  --      an unlisted category whenever treasury_controls.strict_mode is true,
  --      which it has been since 2026-04-09. An unlisted category would make
  --      every affected repayment FAIL at insert.
  -- Checking only the mapping is not sufficient. Both are asserted here so this
  -- migration aborts before touching any function rather than failing mid-loop
  -- with some functions rewritten and others not.
  FOR r IN
    SELECT unnest(ARRAY['agent_advance_repayment','merchandise_recovery_repayment',
                        'bike_recovery_repayment','smartphone_advance_receivable']) AS cat
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.ledger_account_map
                    WHERE category = r.cat AND ledger_scope = 'platform') THEN
      RAISE EXCEPTION 'ABORT: target category % is not mapped — apply 20260923090000 first', r.cat
        USING ERRCODE = '55000';
    END IF;

    IF NOT (r.cat = ANY (public.ledger_category_allowlist())) THEN
      RAISE EXCEPTION 'ABORT: target category % is not in ledger_category_allowlist() — apply 20260923090000 first', r.cat
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  ------------------------------------------------------------------- rewrite
  FOR i IN 1 .. array_length(v_targets, 1) LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_targets[i][1];

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'ABORT: function %s not found', v_targets[i][1] USING ERRCODE = '55000';
    END IF;

    -- wallet legs before: occurrences anchored to recipient_type 'user'
    v_wallet_before := (SELECT count(*) FROM regexp_matches(v_def,
      '''category''\s*,\s*''agent_repayment''\s*,\s*''recipient_type''\s*,\s*''user''', 'g'));

    IF v_targets[i][3] = 'operational' THEN
      -- Anchored on the platform leg's recipient_type. Cannot match the wallet
      -- leg, which carries 'user'.
      v_new := regexp_replace(v_def,
        '(''category''\s*,\s*)''agent_repayment''(\s*,\s*''recipient_type''\s*,\s*''operational_wallet'')',
        '\1' || v_targets[i][2] || '\2', 'g');
    ELSE
      -- cfo_disburse_smartphone_order: platform leg has no recipient_type.
      v_new := regexp_replace(v_def,
        '(''category''\s*,\s*)''agent_repayment''(\s*,\s*''ledger_scope''\s*,\s*''platform'')',
        '\1' || v_targets[i][2] || '\2', 'g');
    END IF;

    IF v_new = v_def THEN
      RAISE EXCEPTION 'ABORT: no platform-leg match in % — live source differs from the reviewed shape',
        v_targets[i][1] USING ERRCODE = '55000';
    END IF;

    -- exactly one platform leg rewritten
    v_before := (SELECT count(*) FROM regexp_matches(v_def, '''agent_repayment''', 'g'));
    v_after  := (SELECT count(*) FROM regexp_matches(v_new, '''agent_repayment''', 'g'));
    IF v_before - v_after <> 1 THEN
      RAISE EXCEPTION 'ABORT: % substitutions in % (expected exactly 1)',
        v_before - v_after, v_targets[i][1] USING ERRCODE = '55000';
    END IF;

    -- the wallet leg must be byte-identical afterwards
    v_wallet_after := (SELECT count(*) FROM regexp_matches(v_new,
      '''category''\s*,\s*''agent_repayment''\s*,\s*''recipient_type''\s*,\s*''user''', 'g'));
    IF v_wallet_after <> v_wallet_before THEN
      RAISE EXCEPTION 'ABORT: wallet leg changed in % (% -> %)',
        v_targets[i][1], v_wallet_before, v_wallet_after USING ERRCODE = '55000';
    END IF;

    EXECUTE v_new;
    v_changed := v_changed + 1;
  END LOOP;

  IF v_changed <> 7 THEN
    RAISE EXCEPTION 'ABORT: rewrote % functions, expected 7', v_changed USING ERRCODE = '55000';
  END IF;

  ------------------------------------------------------------------ postflight
  -- No historical leg may have moved: agent_repayment must still map to A4.
  IF NOT EXISTS (SELECT 1 FROM public.ledger_account_map
                  WHERE category = 'agent_repayment' AND ledger_scope = 'platform'
                    AND account_code = 'A4' AND debit_when = 'cash_out') THEN
    RAISE EXCEPTION 'ABORT: agent_repayment mapping altered' USING ERRCODE = '55000';
  END IF;

  RAISE NOTICE 'Rewrote % function(s). Wallet legs untouched. No ledger row posted.', v_changed;
END
$route$;

COMMIT;

-- EXPECTED EFFECT ON APPLY
--   7 functions re-created; platform leg category only.
--   general_ledger, wallets, rent_requests, agent_collections, repayments: UNCHANGED.
--   Historical balances: UNCHANGED. Only repayments posted AFTER this migration
--   reach A10/A12/A13; everything already in A4 stays there.
