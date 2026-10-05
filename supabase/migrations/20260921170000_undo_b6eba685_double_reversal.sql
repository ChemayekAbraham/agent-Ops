-- APPLIED TO PRODUCTION 2026-09-21 ~18:30 UTC. Recorded here after the fact.
--
-- Undo of a double-reversal on rent request b6eba685, caused by migration
-- 20260921160000 (the 29-July duplicate-recognition reversal).
--
-- WHAT WENT WRONG
-- b6eba685 received four identical recognition postings in the 2026-07-29
-- 11:35-11:45 batch. Three of them had ALREADY been reversed on 2026-08-03 by
-- a prior cleanup, keyed `dup-funding-reversal:b6eba685:<original group>`,
-- which named the exact groups it reversed (405907f4, 176bcdac, 9cc9443c).
--
-- 20260921160000 selected duplicates by ranking the four cash_in legs inside
-- the batch window and reversing ranks 2-4. It excluded the prior reversal
-- LEGS from its population, but never checked whether the ORIGINAL debits had
-- already been offset by a reversal posted OUTSIDE the window. So the same
-- three duplicates were reversed twice.
--
--   A3 understated by 900,000   (should be +300,000, was -600,000)
--   A1 overstated  by 900,000   (should be -300,000, was +600,000)
--
-- SCOPE: exactly one plan. Only b6eba685 carries the `dup-funding-reversal`
-- prefix. The other 56 plans in the batch had no prior duplicate cleanup.
-- Three other plans (f7eb3900, a272aba9, 4a71ad18) carry a single prior
-- cash_out leg each, but those are "CFO-approved allocation return" events --
-- a different economic event, not duplicate cleanup -- so reversing ranks 2-4
-- on those plans was correct and is NOT undone here.
--
-- THIS CORRECTION
-- Three append-only groups, the exact inverse of the three 20260921160000
-- groups for this plan, restoring the position established on 2026-08-03:
--   bridge   rent_receivable_created  cash_in   -> DR A3  300,000
--   platform rent_disbursement        cash_out  -> CR A1  300,000
--
-- Total: 3 groups / 6 legs / A3 +900,000 / A1 -900,000.
--
-- SIDE EFFECT (intended): restores this plan's enforce_single_rent_disbursement
-- net from -2 to +1, putting it back above the duplicate-disbursement
-- threshold. Each cash_out leg passes the guard on the way through (net -2,
-- -1, 0 -- never >= 1).
--
-- Accounting only. No wallet, rent_requests, amount_repaid, agent_collections
-- or repayments write. Both legs are bridge/platform scope, so
-- tr_general_ledger_route_buckets returns at its first line and
-- apply_wallet_movement is unreachable.

BEGIN;

DO $u$
DECLARE
  v_legs int; v_value numeric; v_ins int; v_bad int;
  v_dr_a3 numeric; v_cr_a1 numeric; v_groups int;
BEGIN
  CREATE TEMP TABLE _undo ON COMMIT DROP AS
  SELECT g.id AS c2_leg_id, g.transaction_group_id AS c2_group,
         g.amount, g.user_id, g.source_id AS plan, g.rent_request_id
  FROM public.general_ledger g
  WHERE g.idempotency_key LIKE 'dup_recognition_reversal_20260729:%'
    AND g.category='rent_receivable_created'
    AND g.ledger_scope='bridge'
    AND g.source_id::text LIKE 'b6eba685%';

  SELECT count(*), sum(amount) INTO v_legs, v_value FROM _undo;
  IF v_legs <> 3 OR v_value <> 900000 THEN
    RAISE EXCEPTION 'ABORT: expected 3 legs / UGX 900,000; found % / UGX %', v_legs, v_value
      USING ERRCODE='55000';
  END IF;

  SELECT count(*) INTO v_bad FROM public.general_ledger
   WHERE idempotency_key LIKE 'dup29jul_double_reversal_undo:%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % undo legs already exist', v_bad USING ERRCODE='55000';
  END IF;

  PERFORM set_config('ledger.authorized','true',true);

  INSERT INTO public.general_ledger (
    user_id, amount, direction, category, ledger_scope, classification,
    source_table, source_id, rent_request_id, transaction_group_id,
    transaction_date, description, idempotency_key)
  SELECT u.user_id, u.amount, x.direction, x.category, x.scope, 'production',
         'rent_requests', u.plan, u.rent_request_id,
         md5('dup29undo:'||u.c2_leg_id::text)::uuid, now(),
         format('Undo of double-reversal: reverses Correction 2 leg %s (group %s) for plan b6eba685, whose 29-Jul duplicates were already cleaned up on 2026-08-03 by dup-funding-reversal. Restores the pre-Correction-2 position. Accounting only.',
                u.c2_leg_id, u.c2_group),
         format('dup29jul_double_reversal_undo:%s:%s', u.c2_leg_id, x.tag)
  FROM _undo u
  CROSS JOIN (VALUES
      ('cash_in','rent_receivable_created','bridge','a3'),
      ('cash_out','rent_disbursement','platform','a1')) AS x(direction,category,scope,tag)
  WHERE NOT EXISTS (SELECT 1 FROM public.general_ledger g2
     WHERE g2.idempotency_key = format('dup29jul_double_reversal_undo:%s:%s', u.c2_leg_id, x.tag));

  GET DIAGNOSTICS v_ins = ROW_COUNT;

  SELECT count(*) INTO v_bad FROM public.general_ledger
   WHERE idempotency_key LIKE 'dup29jul_double_reversal_undo:%'
     AND (ledger_scope NOT IN ('bridge','platform') OR wallet_bucket IS NOT NULL
          OR recipient_type IS NOT NULL
          OR category NOT IN ('rent_receivable_created','rent_disbursement'));
  IF v_bad > 0 THEN RAISE EXCEPTION 'ABORT: % bad legs', v_bad USING ERRCODE='55000'; END IF;

  SELECT count(*) INTO v_bad FROM (
    SELECT transaction_group_id FROM public.general_ledger
     WHERE idempotency_key LIKE 'dup29jul_double_reversal_undo:%'
     GROUP BY transaction_group_id
    HAVING abs(sum(CASE WHEN direction='cash_in' THEN amount ELSE -amount END))>0.005) q;
  IF v_bad > 0 THEN RAISE EXCEPTION 'ABORT: % unbalanced groups', v_bad USING ERRCODE='55000'; END IF;

  SELECT count(DISTINCT transaction_group_id),
         sum(CASE WHEN m.account_code='A3' AND g.direction=m.debit_when THEN g.amount ELSE 0 END),
         sum(CASE WHEN m.account_code='A1' AND g.direction<>m.debit_when THEN g.amount ELSE 0 END)
    INTO v_groups, v_dr_a3, v_cr_a1
  FROM public.general_ledger g
  JOIN public.ledger_account_map m ON m.ledger_scope=g.ledger_scope AND m.category=g.category
   AND m.wallet_bucket IS NULL
  WHERE g.idempotency_key LIKE 'dup29jul_double_reversal_undo:%';

  IF v_groups <> 3 OR v_dr_a3 <> 900000 OR v_cr_a1 <> 900000 THEN
    RAISE EXCEPTION 'ABORT: groups % / DR A3 % / CR A1 %, expected 3 / 900000 / 900000',
      v_groups, v_dr_a3, v_cr_a1 USING ERRCODE='55000';
  END IF;

  RAISE NOTICE 'Undo applied: % legs, % groups, DR A3 = CR A1 = %', v_ins, v_groups, v_dr_a3;
END $u$;

COMMIT;
