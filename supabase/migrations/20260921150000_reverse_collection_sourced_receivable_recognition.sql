-- PREPARED FOR REVIEW — NOT APPLIED, NOT RUN, NOT DEPLOYED.
--
-- 1x append-only reversal of an evidenced historical accounting error:
-- `rent_receivable_created` legs posted on tenant COLLECTIONS, which created a
-- new receivable at the moment a tenant repaid one.
--
-- THIS IS A REVERSAL ONLY. It does not re-record the tenant repayment and does
-- not assert where the tenant's cash physically went. That counterpart is
-- unevidenced and remains a separate investigation.
--
-- POPULATION — cleanly matched only (verified 2026-09-21)
--   9,606 correction groups / UGX 253,166,816
--   A leg qualifies only when EXACTLY ONE live agent_collections row matches it
--   on (rent_request_id, amount) within +/- 5 minutes, with reversed_at IS NULL
--   and no [REVERSED: / [VOID note. Verified 1:1 — 9,606 legs map to 9,606
--   distinct collections, zero collisions.
--
--   EXCLUDED  124 legs / UGX  2,042,680  ambiguous (more than one candidate)
--   EXCLUDED 1,064 legs / UGX 19,471,418  no matching collection
--   EXCLUDED     0 legs                   reversed/voided (none exist)
--   Source population 10,794 legs / UGX 274,680,914.
--
-- ORIGINAL RESOLVED EFFECT   DR A3 / CR A2   253,166,816
-- THIS CORRECTION            CR A3 / DR A2   253,166,816
--
-- RESOLVER-VERIFIED (base -> shape -> adj -> mapped, replicated):
--   bridge   rent_receivable_created  cash_out -> acct A3, dw cash_in -> CR A3
--   platform agent_float_cash_offset  cash_in  -> acct A2, dw cash_in -> DR A2
--   n_wallet = 0, n_a2 = 0, n_repay = 0, n_custody = 0 within every group
--   -> R6 does not fire, R7 does not fire, and the
--      agent_float_cash_offset -> L1 override does not fire.
--
-- WHY `agent_float_cash_offset` AND NOT THE HISTORICAL WALLET CATEGORY
-- Re-using `agent_float_used_for_rent` or `rent_payment_for_tenant` on wallet
-- scope would (a) move real float balances and (b) make n_a2 > 0, firing R6/R7
-- and silently inverting the entry. `agent_float_cash_offset` is an existing
-- platform-scope category already mapped to A2, so the correction reaches A2
-- with no wallet leg.
--
-- CLASSIFICATION — MUST BE 'production'
-- sofp_ledger_legs reports a group only when some leg is 'production' or
-- 'legacy_real' (or admin_correction from merchant_float_reconciliations). An
-- 'admin_correction' leg on source_table 'agent_collections' is INVISIBLE to
-- the Balance Sheet — which is why the 46 VOID groups posted on 2026-09-21
-- have no reporting effect. Do not change this classification.
--
-- EXPECTED REPORTING BALANCES (accounting only — not wallets, not cash)
--   A3  976,288,029 -> 723,121,213
--   A2  225,526,177 -> 478,692,993
--
-- NOT CORRECTED HERE: the 19,471,418 unmatched population, the 2,042,680
-- ambiguous population, the repayment-side cash destination, the remaining A3
-- difference, the modern R7 A2 double-count. No A5, A8, L1, suspense, equity
-- or plug entry is created anywhere in this file.

BEGIN;

DO $correction$
DECLARE
  v_legs        int;
  v_value       numeric;
  v_distinct    int;
  v_inserted    int;
  v_bad         int;
  v_dr          numeric;
  v_cr          numeric;
BEGIN
  ------------------------------------------------------------------ population
  CREATE TEMP TABLE _a3_fix ON COMMIT DROP AS
  SELECT l.leg_id, l.plan, l.amount, l.user_id, l.rent_request_id, x.coll_id
  FROM (
    SELECT gl.id AS leg_id, gl.source_id AS plan, gl.amount,
           gl.transaction_date AS tdate, gl.user_id, gl.rent_request_id
    FROM public.general_ledger gl
    WHERE gl.category    = 'rent_receivable_created'
      AND gl.ledger_scope= 'bridge'
      AND gl.source_table= 'agent_collections'
  ) l
  CROSS JOIN LATERAL (
    SELECT count(*) AS n_candidates, (min(c.id::text))::uuid AS coll_id
      FROM public.agent_collections c
     WHERE c.rent_request_id = l.plan
       AND c.amount          = l.amount
       AND c.created_at BETWEEN l.tdate - interval '5 minutes'
                            AND l.tdate + interval '5 minutes'
       AND c.reversed_at IS NULL
       AND COALESCE(c.notes,'') NOT ILIKE '%[REVERSED:%'
       AND COALESCE(c.notes,'') NOT ILIKE '%[VOID%'
  ) x
  WHERE x.n_candidates = 1;   -- uniquely matched only

  SELECT count(*), sum(amount), count(DISTINCT coll_id)
    INTO v_legs, v_value, v_distinct
    FROM _a3_fix;

  IF v_legs <> 9606 OR v_value <> 253166816 THEN
    RAISE EXCEPTION
      'ABORT: population drift. Expected 9,606 legs / UGX 253,166,816; found % / UGX %.',
      v_legs, v_value USING ERRCODE = '55000';
  END IF;

  IF v_distinct <> v_legs THEN
    RAISE EXCEPTION
      'ABORT: % legs claim only % distinct collections — matching is not 1:1.',
      v_legs, v_distinct USING ERRCODE = '55000';
  END IF;

  ------------------------------------------------------------------ the legs
  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO public.general_ledger (
    user_id, amount, direction, category, ledger_scope, classification,
    source_table, source_id, rent_request_id, transaction_group_id,
    transaction_date, description, idempotency_key
  )
  SELECT f.user_id, f.amount, x.direction, x.category, x.scope, 'production',
         'agent_collections', f.plan, f.rent_request_id,
         md5('a3rev:' || f.leg_id::text)::uuid,
         now(),
         format('A3 correction (1x reversal): reverses erroneous '
             || 'rent_receivable_created leg %s, collection %s, which created a '
             || 'receivable on a tenant REPAYMENT. Reversal only — the cash '
             || 'destination is deliberately not recorded.', f.leg_id, f.coll_id),
         format('a3_collection_recognition_reversal:%s:%s', f.leg_id, x.tag)
  FROM _a3_fix f
  CROSS JOIN (VALUES
      ('cash_out', 'rent_receivable_created', 'bridge',   'a3'),
      ('cash_in',  'agent_float_cash_offset', 'platform', 'a2')
  ) AS x(direction, category, scope, tag)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.general_ledger g
     WHERE g.idempotency_key =
           format('a3_collection_recognition_reversal:%s:%s', f.leg_id, x.tag));

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -------------------------------------------------- guard: nothing unexpected
  SELECT count(*) INTO v_bad FROM public.general_ledger
   WHERE idempotency_key LIKE 'a3_collection_recognition_reversal:%'
     AND (ledger_scope NOT IN ('bridge','platform')
          OR wallet_bucket IS NOT NULL
          OR recipient_type IS NOT NULL
          OR category NOT IN ('rent_receivable_created','agent_float_cash_offset'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % correction legs are wallet-scoped or use a disallowed category.', v_bad
      USING ERRCODE = '55000';
  END IF;

  -------------------------------------------------- guard: cash direction = 0
  SELECT count(*) INTO v_bad FROM (
    SELECT transaction_group_id
      FROM public.general_ledger
     WHERE idempotency_key LIKE 'a3_collection_recognition_reversal:%'
     GROUP BY transaction_group_id
    HAVING abs(sum(CASE WHEN direction='cash_in' THEN amount ELSE -amount END)) > 0.005
  ) q;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % correction groups fail the cash-direction balance.', v_bad
      USING ERRCODE = '55000';
  END IF;

  ------------------------------- guard: resolver produces exactly DR A2 / CR A3
  WITH corr AS (
    SELECT COALESCE(gl.transaction_group_id, gl.id) AS gid, gl.ledger_scope AS sc,
           gl.category AS cat, gl.direction AS dir, gl.amount AS amt,
           COALESCE(mw.account_code,'A9') AS acct0,
           COALESCE(mw.debit_when,'cash_in') AS dw0
    FROM public.general_ledger gl
    LEFT JOIN public.ledger_account_map mw
           ON mw.ledger_scope = gl.ledger_scope AND mw.category = gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.idempotency_key LIKE 'a3_collection_recognition_reversal:%'
  ), shp AS (
    SELECT gid,
           count(*) FILTER (WHERE sc='wallet') AS n_wallet,
           count(*) FILTER (WHERE sc='wallet' AND acct0='A2') AS n_a2,
           count(*) FILTER (WHERE sc='platform' AND cat IN
                 ('tenant_repayment','tenant_repayment_collected','rent_repayment')) AS n_repay,
           count(*) FILTER (WHERE sc='platform' AND cat='cash_custody_payable') AS n_custody
    FROM corr GROUP BY gid
  ), adj AS (
    SELECT c.*, CASE
        WHEN c.sc='platform' AND c.cat='agent_float_cash_offset'
             AND s.n_custody>0 AND s.n_wallet>0 AND s.n_a2=0 THEN 'L1'
        ELSE c.acct0 END AS acct,
      CASE
        WHEN c.sc='platform' AND c.cat IN ('tenant_repayment','tenant_repayment_collected',
             'rent_repayment','landlord_receivable_collected') AND s.n_a2>0
          THEN CASE WHEN c.dir='cash_in' THEN 'cash_out' ELSE 'cash_in' END
        WHEN c.sc='wallet' AND c.acct0='A2' AND s.n_repay>0 THEN c.dir
        ELSE c.dw0 END AS dw
    FROM corr c JOIN shp s ON s.gid=c.gid
  )
  SELECT sum(CASE WHEN acct='A2' AND dir=dw THEN amt ELSE 0 END),
         sum(CASE WHEN acct='A3' AND dir<>dw THEN amt ELSE 0 END),
         count(*) FILTER (WHERE acct NOT IN ('A2','A3'))
    INTO v_dr, v_cr, v_bad
    FROM adj;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % correction legs resolve to an account other than A2/A3.', v_bad
      USING ERRCODE = '55000';
  END IF;
  IF v_dr <> 253166816 OR v_cr <> 253166816 THEN
    RAISE EXCEPTION
      'ABORT: resolver gives DR A2 % / CR A3 %, expected 253,166,816 each.', v_dr, v_cr
      USING ERRCODE = '55000';
  END IF;

  RAISE NOTICE 'A3 correction ready: % legs across % groups, UGX %. Resolver DR A2 = CR A3 = %.',
    v_inserted, v_legs, v_value, v_dr;
END
$correction$;

COMMIT;
