-- Make evidenced merchant float corrections visible in the financial statements.
--
-- ── The problem ─────────────────────────────────────────────────────────────
--
-- On 2026-08-27 a merchant desk float was set to UGX 46,350,000,000 when the
-- evidence note read "46350000 float credit" - a 1,000x slip. The operator
-- caught it the same day and posted an evidenced_writedown of 46,303,650,000,
-- leaving the intended 46,350,000. The source records are already correct and
-- this migration does NOT post any new accounting transaction for it.
--
-- The balance sheet still showed the full error, because:
--
--   enforce_correction_classification() forcibly stamps every leg whose
--   category is system_balance_correction / wallet_route_repair /
--   admin_adjustment with classification = 'admin_correction'
--
--   ...while get_statement_of_financial_position and get_treasury_cash_position
--   report only classification IN ('production','legacy_real')
--
-- So the error (production) was included and its correction (admin_correction)
-- was not. This is systemic, not a one-off: 3,332 correction groups holding
-- UGX 100.7bn never reach the statement.
--
-- ── Why the fix is scoped rather than general ───────────────────────────────
--
-- Including every admin_correction leg was modelled first and rejected:
--
--   all admin_correction         -> trial balance off by  1,430,956,865
--                                   L1 -1,812,659,141, E3 +393,610,884,
--                                   X3 +101,837,913 - material distortion
--   self-balancing groups only   -> trial balance off by    327,595,642
--                                   (raw cash_in = cash_out does not survive
--                                    account/side resolution)
--   merchant_float_reconciliations -> A1 +46,505,830,585
--                                     A2 -46,505,830,585
--                                     TOTAL 0, no other account touched
--
-- Only the last is safe, so only that source is made reportable. These are
-- evidenced corrections to A1/A2 balances that are themselves reportable, which
-- is exactly the class of correction that belongs in the statement.
--
-- ── Implementation note ─────────────────────────────────────────────────────
--
-- In sofp_ledger_legs the predicate is widened inside the already-materialised
-- grp_class aggregate, NOT bolted onto the main WHERE with an OR. The OR form
-- was tried first and defeated the index: dates that previously returned in
-- seconds began timing out. Widening has_reportable keeps the hot filter on a
-- single indexed expression and restored the original performance
-- (2026-08-13 = 402,108 legs, imbalance 0).
--
-- No ledger row, mapping, balance or classification is modified. This changes
-- only which existing rows the two reporting functions read, and the ledger
-- stays append-only. The audit trail is untouched: both the original entry and
-- its writedown remain exactly as posted.

-- ── 1. Statement of financial position ──────────────────────────────────────
DO $do$
DECLARE
  v_def text; v_new text;
  v_old text := E'bool_or(gl.classification IN (''production'',''legacy_real'')) AS has_reportable';
  v_new_agg text := E'bool_or(gl.classification IN (''production'',''legacy_real'')\n                   OR (gl.classification = ''admin_correction''\n                       AND gl.source_table = ''merchant_float_reconciliations'')) AS has_reportable';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'sofp_ledger_legs';

  IF v_def IS NULL THEN RAISE EXCEPTION 'sofp_ledger_legs not found'; END IF;

  IF position('merchant_float_reconciliations' in v_def) > 0 THEN
    RAISE NOTICE 'sofp_ledger_legs already updated - skipping';
  ELSE
    IF position(v_old in v_def) = 0 THEN
      RAISE EXCEPTION 'grp_class aggregate not found - aborting rather than guessing';
    END IF;
    v_new := replace(v_def, v_old, v_new_agg);
    EXECUTE v_new;
    RAISE NOTICE 'sofp_ledger_legs updated';
  END IF;
END
$do$;

-- ── 2. Treasury cash position (feeds the CFO cash cards) ────────────────────
DO $do$
DECLARE
  v_def text; v_new text;
  v_old text := E'WHERE gl.classification IN (''production'',''legacy_real'')\n      AND gl.transaction_date <= p_as_at';
  v_rep text := E'WHERE (gl.classification IN (''production'',''legacy_real'')\n             OR (gl.classification = ''admin_correction''\n                 AND gl.source_table = ''merchant_float_reconciliations''))\n      AND gl.transaction_date <= p_as_at';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_treasury_cash_position';

  IF v_def IS NULL THEN RAISE EXCEPTION 'get_treasury_cash_position not found'; END IF;

  IF position('merchant_float_reconciliations' in v_def) > 0 THEN
    RAISE NOTICE 'get_treasury_cash_position already updated - skipping';
  ELSE
    IF position(v_old in v_def) = 0 THEN
      RAISE EXCEPTION 'classification filter not found - aborting rather than guessing';
    END IF;
    v_new := replace(v_def, v_old, v_rep);
    EXECUTE v_new;
    RAISE NOTICE 'get_treasury_cash_position updated';
  END IF;
END
$do$;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- The Sky Bubbles correction group becomes reportable without being altered:
--
--   SELECT bool_or(classification IN ('production','legacy_real')) AS before,
--          bool_or(classification IN ('production','legacy_real')
--                  OR (classification='admin_correction'
--                      AND source_table='merchant_float_reconciliations')) AS after
--     FROM general_ledger
--    WHERE transaction_group_id = '06b057a7-91b0-4b25-9c80-08138bb80120';
--   -- expect before = false, after = true
--
-- The statement still balances:
--
--   SELECT ROUND(SUM(dr)-SUM(cr)) AS imbalance
--     FROM public.sofp_ledger_legs('2026-08-13'::timestamptz);
--   -- expect 0
