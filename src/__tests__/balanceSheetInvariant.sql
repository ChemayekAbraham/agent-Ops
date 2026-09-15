-- Balance sheet (statement of financial position) regression guard.
--
-- Protects the three failure modes behind the UGX 367,127,036 imbalance:
--   1. rent collections classified with both legs on the same side
--   2. personal-balance deposits recognising the custody liability twice
--   3. agent float top-ups counted as company bank cash AND agent-held cash
-- plus the hard invariant Assets = Liabilities + Equity.
--
-- Read-only against real data. New-transaction simulation runs against a TEMP
-- copy of general_ledger fed to a TEMP clone of sofp_ledger_legs built from the
-- live function source, so the tested rules can never drift from production and
-- nothing is written to any real table.

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE TEMP TABLE bs_legs AS SELECT * FROM sofp_ledger_legs(now());

-- ── 1. invariant on real data, at every reporting checkpoint ──────────────
\echo '== 1 Assets = Liabilities + Equity at each checkpoint'
DO $$
DECLARE d timestamptz; diff numeric; tb numeric;
BEGIN
  FOREACH d IN ARRAY ARRAY['2026-04-30 23:59:59+00','2026-06-30 23:59:59+00',
                           '2026-07-31 23:59:59+00','2026-08-31 23:59:59+00',
                           now()]::timestamptz[]
  LOOP
    SELECT round(sum(CASE WHEN c.nature = 'asset' THEN l.dr - l.cr ELSE 0 END)
             - (sum(CASE WHEN c.nature = 'liability' THEN l.cr - l.dr ELSE 0 END)
              + sum(CASE WHEN c.nature = 'equity'    THEN l.cr - l.dr ELSE 0 END)
              + sum(CASE WHEN c.nature = 'revenue'   THEN l.cr - l.dr ELSE 0 END)
              - sum(CASE WHEN c.nature = 'expense'   THEN l.dr - l.cr ELSE 0 END))),
           round(sum(l.dr) - sum(l.cr))
      INTO diff, tb
      FROM sofp_ledger_legs(d) l
      JOIN ledger_account_catalog c ON c.code = l.account_code;
    IF diff <> 0 OR tb <> 0 THEN
      RAISE EXCEPTION 'FAIL balance sheet unbalanced at % (A-(L+E)=%, debits-credits=%)', d, diff, tb;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS invariant holds at all checkpoints';
END $$;

-- ── 2. no balanced ledger group may map both legs to the same side ────────
\echo '== 2 balanced ledger groups map to equal debits and credits'
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM (SELECT transaction_group_id gid, sum(dr - cr) diff
        FROM bs_legs
        WHERE NOT is_legacy_counterpart AND transaction_group_id IS NOT NULL
        GROUP BY 1) x
  WHERE abs(x.diff) > 0.5
    AND x.gid IN (SELECT transaction_group_id FROM general_ledger
                  WHERE transaction_group_id IS NOT NULL
                  GROUP BY 1
                  HAVING abs(sum(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END)) < 0.5);
  IF n > 0 THEN
    RAISE EXCEPTION 'FAIL % balanced ledger group(s) classified onto one side', n;
  END IF;
  RAISE NOTICE 'PASS no same-side classification';
END $$;

-- ── 3. rent collections: cash once, receivable once, either convention ────
\echo '== 3 rent collections recognise cash and receivable exactly once'
DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad
  FROM (SELECT l.transaction_group_id gid,
               sum(CASE WHEN l.account_code = 'A2' THEN l.dr - l.cr ELSE 0 END) a2,
               sum(CASE WHEN l.account_code = 'A3' THEN l.dr - l.cr ELSE 0 END) a3,
               sum(l.dr - l.cr) diff
        FROM bs_legs l
        WHERE NOT l.is_legacy_counterpart
          AND l.transaction_group_id IN (
            SELECT g.transaction_group_id FROM general_ledger g
            WHERE g.ledger_scope = 'platform'
              AND g.category IN ('tenant_repayment','tenant_repayment_collected',
                                 'rent_repayment','landlord_receivable_collected')
              AND g.transaction_group_id IS NOT NULL
            GROUP BY 1
            HAVING abs(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END)) < 0.5)
        GROUP BY 1) x
  WHERE abs(x.diff) > 0.5 OR x.a2 < -0.5 OR x.a3 > 0.5;
  IF bad > 0 THEN
    RAISE EXCEPTION 'FAIL % rent collection group(s) misclassified (float credited or receivable increased)', bad;
  END IF;
  RAISE NOTICE 'PASS rent collections';
END $$;

-- ── 4. personal-balance deposits: custody liability recognised once ───────
\echo '== 4 personal-balance deposits recognise the liability exactly once'
DO $$
DECLARE bad bigint;
BEGIN
  WITH tg AS (
    SELECT g.transaction_group_id gid,
           sum(g.amount) FILTER (WHERE g.ledger_scope = 'wallet'
                                   AND g.wallet_bucket = 'withdrawable') amt
    FROM general_ledger g
    WHERE g.transaction_group_id IS NOT NULL
      AND g.transaction_group_id IN (SELECT transaction_group_id FROM general_ledger
                                     WHERE ledger_scope = 'platform' AND category = 'cash_custody_payable')
      AND g.transaction_group_id IN (SELECT transaction_group_id FROM general_ledger
                                     WHERE ledger_scope = 'platform' AND category = 'agent_float_cash_offset')
    GROUP BY 1
    HAVING sum(g.amount) FILTER (WHERE g.ledger_scope = 'wallet' AND g.wallet_bucket = 'float') IS NULL
  )
  SELECT count(*) INTO bad
  FROM tg
  JOIN (SELECT transaction_group_id gid,
               sum(CASE WHEN account_code = 'L1' THEN cr - dr ELSE 0 END) l1,
               sum(l.dr - l.cr) diff
        FROM bs_legs l WHERE NOT is_legacy_counterpart GROUP BY 1) x ON x.gid = tg.gid
  WHERE abs(x.diff) > 0.5 OR abs(x.l1 - tg.amt) > 0.5;
  IF bad > 0 THEN
    RAISE EXCEPTION 'FAIL % personal-balance deposit(s) with duplicated or missing custody liability', bad;
  END IF;
  RAISE NOTICE 'PASS personal-balance deposits';
END $$;

-- ── 5. float top-ups: cash cannot sit in two asset locations at once ──────
\echo '== 5 float top-ups move cash, never duplicate it'
DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad
  FROM (SELECT l.transaction_group_id gid,
               sum(CASE WHEN l.account_code = 'A1' THEN l.dr - l.cr ELSE 0 END) a1,
               sum(CASE WHEN l.account_code = 'A2' THEN l.dr - l.cr ELSE 0 END) a2,
               sum(l.dr - l.cr) diff
        FROM bs_legs l
        WHERE NOT l.is_legacy_counterpart
          AND l.transaction_group_id IN (
            SELECT transaction_group_id FROM general_ledger
            WHERE ledger_scope = 'platform' AND category = 'wallet_deposit' AND direction = 'cash_out'
              AND transaction_group_id IS NOT NULL)
          AND l.transaction_group_id IN (
            SELECT transaction_group_id FROM general_ledger
            WHERE ledger_scope = 'wallet' AND wallet_bucket = 'float'
              AND transaction_group_id IS NOT NULL)
        GROUP BY 1) x
  WHERE abs(x.diff) > 0.5 OR (x.a1 > 0.5 AND x.a2 > 0.5);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FAIL % float top-up(s) counting the same cash twice', bad;
  END IF;
  RAISE NOTICE 'PASS float top-ups';
END $$;

-- ── 6. new transactions of every affected type, simulated ────────────────
\echo '== 6 newly created transactions stay balanced'
DO $$
DECLARE src text; g uuid; diff numeric;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'sofp_ledger_legs';
  EXECUTE 'CREATE TEMP TABLE bs_sim AS SELECT * FROM public.general_ledger WITH NO DATA';
  EXECUTE 'CREATE TEMP VIEW bs_gl AS SELECT * FROM public.general_ledger UNION ALL SELECT * FROM bs_sim';
  EXECUTE 'CREATE FUNCTION pg_temp.bs_sofp(p_as_at timestamptz) RETURNS TABLE('
        || 'transaction_group_id uuid, ledger_scope text, category text, source_table text,'
        || 'account_code text, dr numeric, cr numeric, group_one_sided boolean,'
        || 'is_legacy_counterpart boolean) LANGUAGE sql STABLE AS $x$'
        || replace(src, 'general_ledger', 'bs_gl') || '$x$';

  FOR g, diff IN
    WITH s(name, legs) AS (VALUES
      ('rent collection, agent holds the cash', jsonb_build_array(
        jsonb_build_object('sc','wallet','cat','agent_float_deposit','dir','cash_in','amt',200000,'bucket','float'),
        jsonb_build_object('sc','platform','cat','tenant_repayment','dir','cash_in','amt',200000))),
      ('rent collection, float used for rent', jsonb_build_array(
        jsonb_build_object('sc','wallet','cat','agent_float_used_for_rent','dir','cash_out','amt',200000,'bucket','float'),
        jsonb_build_object('sc','platform','cat','tenant_repayment','dir','cash_in','amt',200000))),
      ('rent collection, tiny instalment', jsonb_build_array(
        jsonb_build_object('sc','wallet','cat','agent_float_used_for_rent','dir','cash_out','amt',1,'bucket','float'),
        jsonb_build_object('sc','platform','cat','tenant_repayment','dir','cash_in','amt',1))),
      ('rent collection with commission', jsonb_build_array(
        jsonb_build_object('sc','wallet','cat','agent_float_used_for_rent','dir','cash_out','amt',300000,'bucket','float'),
        jsonb_build_object('sc','platform','cat','tenant_repayment','dir','cash_in','amt',300000),
        jsonb_build_object('sc','wallet','cat','agent_commission_earned','dir','cash_in','amt',30000,'bucket','withdrawable'),
        jsonb_build_object('sc','platform','cat','agent_commission_earned','dir','cash_out','amt',30000))),
      ('personal-balance cash deposit', jsonb_build_array(
        jsonb_build_object('sc','wallet','cat','wallet_deposit','dir','cash_in','amt',500000,'bucket','withdrawable'),
        jsonb_build_object('sc','platform','cat','cash_receipt_in_transit','dir','cash_in','amt',500000),
        jsonb_build_object('sc','platform','cat','cash_custody_payable','dir','cash_out','amt',500000),
        jsonb_build_object('sc','platform','cat','agent_float_cash_offset','dir','cash_out','amt',500000))),
      ('agent float top-up banked to the company', jsonb_build_array(
        jsonb_build_object('sc','wallet','cat','agent_float_topup','dir','cash_out','amt',300000,'bucket','float'),
        jsonb_build_object('sc','platform','cat','wallet_deposit','dir','cash_out','amt',300000))),
      ('company bank transfer', jsonb_build_array(
        jsonb_build_object('sc','platform','cat','treasury_bank_deposit','dir','cash_in','amt',900000),
        jsonb_build_object('sc','platform','cat','cash_at_bank_reclass','dir','cash_out','amt',900000)))
    ), ins AS (
      SELECT s.name, gen_random_uuid() gid, l FROM s, jsonb_array_elements(s.legs) l
    ), w AS (
      INSERT INTO bs_sim (id, transaction_group_id, user_id, ledger_scope, category, direction,
                          amount, wallet_bucket, source_table, classification, transaction_date,
                          currency, created_at, maturity_met, maturity_expired)
      SELECT gen_random_uuid(), first_value(gid) OVER (PARTITION BY name), gen_random_uuid(),
             l->>'sc', l->>'cat', l->>'dir', (l->>'amt')::numeric, l->>'bucket',
             'regression_test', 'production', now(), 'UGX', now(), false, false
      FROM ins
      RETURNING transaction_group_id
    )
    SELECT x.gid, x.d FROM (
      SELECT b.transaction_group_id gid, round(sum(b.dr - b.cr)) d
      FROM pg_temp.bs_sofp(now()) b
      WHERE b.transaction_group_id IN (SELECT transaction_group_id FROM w)
      GROUP BY 1) x
    WHERE abs(x.d) > 0.5
  LOOP
    RAISE EXCEPTION 'FAIL simulated group % unbalanced by %', g, diff;
  END LOOP;

  SELECT round(sum(b.dr) - sum(b.cr)) INTO diff FROM pg_temp.bs_sofp(now()) b;
  IF diff <> 0 THEN
    RAISE EXCEPTION 'FAIL trial balance off by % once simulated transactions are applied', diff;
  END IF;
  RAISE NOTICE 'PASS simulated new transactions';
END $$;

ROLLBACK;
