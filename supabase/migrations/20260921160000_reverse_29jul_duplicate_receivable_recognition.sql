-- PREPARED FOR REVIEW — NOT APPLIED, NOT DEPLOYED, NOT PUSHED.
--
-- Append-only reversal of the 2026-07-29 duplicate receivable-recognition batch.
--
-- WHAT HAPPENED
-- Between 11:35:00 and 11:45:00 UTC on 2026-07-29 a recognition batch ran FOUR
-- times. Each of 57 rent plans received four identical `rent_receivable_created`
-- postings — same amount, same description, roughly two minutes apart. Examples:
--   035f5581 Kilya john       UGX   200,000 at 11:37, 11:39, 11:41, 11:43
--   0468846b sebuliba bosco   UGX 2,000,000 at 11:37, 11:39, 11:42, 11:44
--   078d904b Tony Balondemu   UGX   300,000 at 11:36, 11:38, 11:41, 11:43
-- One posting per plan is correct; postings 2-4 are duplicates.
--
-- ORIGINAL GROUP STRUCTURE — verified on all 228 groups, no exceptions
--   bridge   rent_receivable_created  cash_in   -> A3 (dw cash_in)  -> DR A3
--   platform rent_disbursement        cash_out  -> A1 (dw cash_in)  -> CR A1
-- Exactly two legs per group, equal amounts, internally balanced.
--
-- THE COUNTERPART IS A1, NOT A2
-- Traced from the ledger, not inferred. Description: "Rent float funded for
-- agent to pay landlord". No resolver override applies — `rent_disbursement`
-- routes to A4 only when source_table = 'agent_advance_requests'; here it is
-- 'rent_requests'.
--
-- So the duplicates did not only inflate A3. They also credited bank cash:
--   A3 overstated   +131,790,000
--   A1 understated  -131,790,000
-- This correction restores BOTH. It is not an A3-only adjustment.
--
-- WHY THIS CANNOT RECUR
-- `enforce_single_rent_disbursement` blocks a second platform/cash_out
-- `rent_disbursement` for the same rent_request. It was added by migration
-- 20260803093402 — five days AFTER this batch. The control now exists.
-- It does not block this correction: the guard returns immediately unless
-- direction = 'cash_out', and the reversal leg is cash_in.
--
-- SCOPE
-- Append-only. No original ledger row is read for update, modified or deleted.
-- No wallet, wallets_physical, rent_requests, agent_collections, amount_repaid,
-- repayment record, ledger mapping or reporting source is touched. Both
-- correction legs are platform/bridge scope, so tr_general_ledger_route_buckets
-- returns at its first line and apply_wallet_movement is never called.
--
-- INDEPENDENCE FROM CORRECTION 1
-- Zero shared transaction_group_id values with the 253,166,816 collection
-- correction (20260921150000) — verified directly. Different source_table,
-- different group structure, different counterpart (A1 here, A2 there).
--
-- NOT REVERSED HERE, deliberately:
--   * the first posting per plan (UGX 43,930,000)
--   * the 6 existing reversal legs (UGX 1,860,000)
--   * the balanced system_balance_correction pair (UGX 20,015,000 each way)
--   * any agent_collections-sourced recognition
--   * any other A3 recognition
-- Whether the FIRST recognition should exist on the 3 rejected and 1 cancelled
-- plans in this population is a separate question. A plan cannot legitimately be
-- recognised four times either way, so the duplicate reversal does not depend
-- on it.

BEGIN;

DO $correction$
DECLARE
  v_legs        int;
  v_value       numeric;
  v_plans       int;
  v_badshape    int;
  v_percount    int;
  v_inserted    int;
  v_unbalanced  int;
  v_dr_a1       numeric;
  v_cr_a3       numeric;
BEGIN
  ---------------------------------------------------------------- population
  CREATE TEMP TABLE _dup29 ON COMMIT DROP AS
  SELECT leg_id, gid, plan, amount, user_id, rn
  FROM (
    SELECT gl.id AS leg_id,
           COALESCE(gl.transaction_group_id, gl.id) AS gid,
           COALESCE(gl.rent_request_id, gl.source_id) AS plan,
           gl.amount, gl.user_id,
           row_number() OVER (PARTITION BY COALESCE(gl.rent_request_id, gl.source_id)
                              ORDER BY gl.transaction_date, gl.id) AS rn
    FROM public.general_ledger gl
    WHERE gl.category      = 'rent_receivable_created'
      AND gl.ledger_scope  = 'bridge'
      AND gl.source_table  = 'rent_requests'
      AND gl.classification = 'production'
      AND gl.transaction_date >= '2026-07-29 11:35:00+00'
      AND gl.transaction_date <  '2026-07-29 11:45:00+00'
  ) q
  WHERE q.rn > 1;                     -- keep the earliest posting per plan

  SELECT count(*), sum(amount), count(DISTINCT plan) INTO v_legs, v_value, v_plans FROM _dup29;

  -- 1/2/3 population, value, plans
  IF v_legs <> 171 OR v_value <> 131790000 OR v_plans <> 57 THEN
    RAISE EXCEPTION
      'ABORT: expected 171 legs / UGX 131,790,000 / 57 plans; found % / UGX % / %.',
      v_legs, v_value, v_plans USING ERRCODE = '55000';
  END IF;

  -- 4 exactly three duplicates per plan
  SELECT count(*) INTO v_percount
  FROM (SELECT plan FROM _dup29 GROUP BY plan HAVING count(*) <> 3) q;
  IF v_percount > 0 THEN
    RAISE EXCEPTION 'ABORT: % plans do not have exactly 3 duplicate postings.', v_percount
      USING ERRCODE = '55000';
  END IF;

  -- 5 every original group is the expected balanced A3/A1 two-leg shape
  SELECT count(*) INTO v_badshape
  FROM _dup29 d
  WHERE NOT EXISTS (
    SELECT 1 FROM public.general_ledger g
     WHERE COALESCE(g.transaction_group_id, g.id) = d.gid
       AND g.ledger_scope='platform' AND g.category='rent_disbursement'
       AND g.direction='cash_out' AND g.amount = d.amount)
     OR (SELECT count(*) FROM public.general_ledger g2
          WHERE COALESCE(g2.transaction_group_id, g2.id) = d.gid) <> 2;
  IF v_badshape > 0 THEN
    RAISE EXCEPTION 'ABORT: % duplicate groups lack the expected A3/A1 two-leg structure.', v_badshape
      USING ERRCODE = '55000';
  END IF;

  -- 9 zero overlap with Correction 1
  SELECT count(*) INTO v_badshape
  FROM _dup29 d
  WHERE d.gid IN (
    SELECT COALESCE(transaction_group_id, id) FROM public.general_ledger
     WHERE category='rent_receivable_created' AND ledger_scope='bridge'
       AND source_table='agent_collections');
  IF v_badshape > 0 THEN
    RAISE EXCEPTION 'ABORT: % groups are shared with the Correction 1 population.', v_badshape
      USING ERRCODE = '55000';
  END IF;

  ------------------------------------------------------------------- the legs
  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO public.general_ledger (
    user_id, amount, direction, category, ledger_scope, classification,
    source_table, source_id, rent_request_id, transaction_group_id,
    transaction_date, description, idempotency_key
  )
  SELECT d.user_id, d.amount, x.direction, x.category, x.scope, 'production',
         'rent_requests', d.plan, d.plan,
         md5('dup29jul:' || d.leg_id::text)::uuid,
         now(),
         format('A3/A1 correction: reverses duplicate rent_receivable_created leg %s '
             || '(group %s, posting %s of 4) from the 2026-07-29 11:35-11:45 batch '
             || 'that ran four times. Restores A1 and removes the duplicate A3 '
             || 'recognition. The first posting for this plan is retained.',
             d.leg_id, d.gid, d.rn),
         format('dup_recognition_reversal_20260729:%s:%s', d.leg_id, x.tag)
  FROM _dup29 d
  CROSS JOIN (VALUES
      ('cash_in',  'rent_disbursement',       'platform', 'a1'),
      ('cash_out', 'rent_receivable_created', 'bridge',   'a3')
  ) AS x(direction, category, scope, tag)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.general_ledger g
     WHERE g.idempotency_key =
           format('dup_recognition_reversal_20260729:%s:%s', d.leg_id, x.tag));

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  ------------------------------------------------- guard: nothing unexpected
  SELECT count(*) INTO v_badshape FROM public.general_ledger
   WHERE idempotency_key LIKE 'dup_recognition_reversal_20260729:%'
     AND (ledger_scope NOT IN ('bridge','platform')
          OR wallet_bucket IS NOT NULL
          OR recipient_type IS NOT NULL
          OR category NOT IN ('rent_receivable_created','rent_disbursement'));
  IF v_badshape > 0 THEN
    RAISE EXCEPTION 'ABORT: % correction legs are wallet-scoped or use a disallowed category.', v_badshape
      USING ERRCODE = '55000';
  END IF;

  -- 6 every correction group balances on cash direction
  SELECT count(*) INTO v_unbalanced FROM (
    SELECT transaction_group_id FROM public.general_ledger
     WHERE idempotency_key LIKE 'dup_recognition_reversal_20260729:%'
     GROUP BY transaction_group_id
    HAVING abs(sum(CASE WHEN direction='cash_in' THEN amount ELSE -amount END)) > 0.005
  ) q;
  IF v_unbalanced > 0 THEN
    RAISE EXCEPTION 'ABORT: % correction groups fail the cash-direction balance.', v_unbalanced
      USING ERRCODE = '55000';
  END IF;

  ------------------------------- guard: resolver gives exactly DR A1 / CR A3
  SELECT
    sum(CASE WHEN m.account_code='A1' AND g.direction = m.debit_when THEN g.amount ELSE 0 END),
    sum(CASE WHEN m.account_code='A3' AND g.direction <> m.debit_when THEN g.amount ELSE 0 END)
  INTO v_dr_a1, v_cr_a3
  FROM public.general_ledger g
  JOIN public.ledger_account_map m
    ON m.ledger_scope=g.ledger_scope AND m.category=g.category AND m.wallet_bucket IS NULL
  WHERE g.idempotency_key LIKE 'dup_recognition_reversal_20260729:%';

  IF v_dr_a1 <> 131790000 OR v_cr_a3 <> 131790000 THEN
    RAISE EXCEPTION
      'ABORT: resolver gives DR A1 % / CR A3 %, expected 131,790,000 each.', v_dr_a1, v_cr_a3
      USING ERRCODE = '55000';
  END IF;

  RAISE NOTICE 'Duplicate reversal ready: % legs across % groups, UGX %. DR A1 = CR A3 = %.',
    v_inserted, v_legs, v_value, v_dr_a1;
END
$correction$;

COMMIT;

-- EXPECTED EFFECT
--   A3  -131,790,000
--   A1  +131,790,000
--   Wallets, rent_requests, amount_repaid, agent_collections: UNCHANGED.
--   Original ledger rows: UNTOUCHED.
