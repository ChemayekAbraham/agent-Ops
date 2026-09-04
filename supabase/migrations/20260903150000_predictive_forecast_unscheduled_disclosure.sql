-- Disclose the receivables/payables that the forecast cannot place on a timeline.
--
-- ── Why ─────────────────────────────────────────────────────────────────────
--
-- Both predictive forecasts silently drop any line they cannot schedule. A line
-- is forecastable only if it is 'scheduled' with a due_date, or 'projected' with
-- a daily_amount > 0. Anything failing both tests contributes nothing to the
-- timeline and no residual is shown, so a data gap in the source tables reads as
-- a smaller book rather than an unknown one.
--
-- Measured at the time of writing:
--
--   receivables   94 items   157,030,361   (81 promissory notes with a NULL
--                                            next_deduction_date = 154,885,000,
--                                            13 rent plans with daily_repayment
--                                            of zero = 2,145,361)
--   payables     641 items    12,556,609   (wallet balances - payable on demand,
--                                            so genuinely unschedulable)
--
-- On the receivables side that is ~19% of the book invisible to the forecast.
--
-- ── What this adds ──────────────────────────────────────────────────────────
--
-- One key, 'unscheduled', on each predictive forecast payload: item count,
-- amount and a per-product split, derived from the same authoritative
-- v_receivables_lines / v_payables_lines the forecasts already read.
--
-- The predicate is identical to the one get_receivables_forecast already uses
-- for its unscheduled_outstanding field, so the deterministic and predictive
-- forecasts agree on what "unschedulable" means:
--
--   (due_kind = 'projected' AND COALESCE(daily_amount, 0) <= 0)
--   OR (due_kind = 'scheduled' AND due_date IS NULL)
--
-- ── What this does NOT change ───────────────────────────────────────────────
--
-- No predictive calculation is touched: not the run-off model, the origination
-- model, the backtest damping, the confidence banding, or any period figure.
-- No due date or daily amount is invented. No ledger entry, mapping, balance or
-- accounting classification is affected. Total Receivables and Total Payables
-- are unchanged - these lines were always counted in the book, and remain so.
--
-- Verified after applying, per side: scheduled + projected + unscheduled equals
-- the total exactly, in both item count and amount, so the three buckets are
-- mutually exclusive and exhaustive and no line is double counted.
--
-- Each block is a guarded text replacement against the live definition rather
-- than a restatement of a 20k-character function, so no unrelated line can
-- drift, and each is a no-op when already applied.

-- ── Receivables ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_def text; v_new text; v_old text; v_repl text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_receivables_predictive_forecast';

  IF v_def IS NULL THEN RAISE EXCEPTION 'get_receivables_predictive_forecast not found'; END IF;
  IF v_def LIKE '%''unscheduled''%' THEN
    RAISE NOTICE 'receivables forecast already discloses unscheduled - skipping'; RETURN;
  END IF;

  v_old := '''source'', ''v_receivables_lines + v_receivables_collection_history + observed origination history''' || E'\n  )';
  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'meta close anchor not found - aborting rather than guessing';
  END IF;

  v_repl := '''source'', ''v_receivables_lines + v_receivables_collection_history + observed origination history''' || E'\n  ),\n' ||
    '  ''unscheduled'', (' || E'\n' ||
    '    SELECT jsonb_build_object(' || E'\n' ||
    '             ''items'',      COALESCE(SUM(c), 0),' || E'\n' ||
    '             ''amount'',     COALESCE(SUM(amt), 0),' || E'\n' ||
    '             ''by_product'', COALESCE(jsonb_object_agg(product_key, amt), ''{}''::jsonb),' || E'\n' ||
    '             ''note'',       ''Included in Total Receivables, excluded from the forecast timeline: no contractual date and no daily amount to project from.'')' || E'\n' ||
    '      FROM (SELECT product_key, ROUND(SUM(outstanding_amount), 2) AS amt, COUNT(*) AS c' || E'\n' ||
    '              FROM v_receivables_lines' || E'\n' ||
    '             WHERE (due_kind = ''projected'' AND COALESCE(daily_amount, 0) <= 0)' || E'\n' ||
    '                OR (due_kind = ''scheduled'' AND due_date IS NULL)' || E'\n' ||
    '             GROUP BY product_key) q' || E'\n' ||
    '  )';

  v_new := replace(v_def, v_old, v_repl);
  IF v_new = v_def THEN RAISE EXCEPTION 'replacement made no change - aborting'; END IF;
  EXECUTE v_new;
  RAISE NOTICE 'get_receivables_predictive_forecast updated';
END
$do$;

-- ── Payables ────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_def text; v_new text; v_old text; v_repl text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_payables_predictive_forecast';

  IF v_def IS NULL THEN RAISE EXCEPTION 'get_payables_predictive_forecast not found'; END IF;
  IF v_def LIKE '%''unscheduled''%' THEN
    RAISE NOTICE 'payables forecast already discloses unscheduled - skipping'; RETURN;
  END IF;

  v_old := '''source'', ''v_payables_lines + v_payables_payment_history + observed obligation-creation history''' || E'\n  )';
  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'meta close anchor not found - aborting rather than guessing';
  END IF;

  v_repl := '''source'', ''v_payables_lines + v_payables_payment_history + observed obligation-creation history''' || E'\n  ),\n' ||
    '  ''unscheduled'', (' || E'\n' ||
    '    SELECT jsonb_build_object(' || E'\n' ||
    '             ''items'',      COALESCE(SUM(c), 0),' || E'\n' ||
    '             ''amount'',     COALESCE(SUM(amt), 0),' || E'\n' ||
    '             ''by_product'', COALESCE(jsonb_object_agg(product_key, amt), ''{}''::jsonb),' || E'\n' ||
    '             ''note'',       ''Payable on demand. Included in Total Payables, excluded from the forecast timeline: no contractual due date and no daily amount to project from.'')' || E'\n' ||
    '      FROM (SELECT product_key, ROUND(SUM(outstanding_amount), 2) AS amt, COUNT(*) AS c' || E'\n' ||
    '              FROM v_payables_lines' || E'\n' ||
    '             WHERE (due_kind = ''projected'' AND COALESCE(daily_amount, 0) <= 0)' || E'\n' ||
    '                OR (due_kind = ''scheduled'' AND due_date IS NULL)' || E'\n' ||
    '             GROUP BY product_key) q' || E'\n' ||
    '  )';

  v_new := replace(v_def, v_old, v_repl);
  IF v_new = v_def THEN RAISE EXCEPTION 'replacement made no change - aborting'; END IF;
  EXECUTE v_new;
  RAISE NOTICE 'get_payables_predictive_forecast updated';
END
$do$;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- The three buckets must partition each book exactly - same item count and
-- same amount as the unfiltered total:
--
--   SELECT CASE WHEN (due_kind='projected' AND COALESCE(daily_amount,0) <= 0)
--                 OR (due_kind='scheduled' AND due_date IS NULL) THEN 'unscheduled'
--               ELSE due_kind END AS bucket,
--          COUNT(*) items, ROUND(SUM(outstanding_amount)) amount
--     FROM v_receivables_lines GROUP BY 1
--   UNION ALL
--   SELECT 'TOTAL', COUNT(*), ROUND(SUM(outstanding_amount)) FROM v_receivables_lines;
--
-- Repeat against v_payables_lines. Both sides reconciled at the time of writing.
