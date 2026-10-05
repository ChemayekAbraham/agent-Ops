-- PREPARED FOR REVIEW — NOT APPLIED, NOT DEPLOYED, NOT PUSHED.
--
-- Closes the half-applied float <-> withdrawable correction.
--
-- BACKGROUND
-- The design audit of 2026-09-23 specified three changes. Change 3 (rewrite
-- sofp_ledger_legs: narrow the shape-keyed A8 override off the three bucket
-- movement categories and inject an X4 counterpart) WAS deployed. Change 2
-- (flip the two bucket_reclass_* withdrawable mapping rows from debit_when
-- 'cash_in' to 'cash_out', so a custody inflow reads as a credit) was NOT.
-- The audit sequenced them together and noted Change 2 is inert until Change 3
-- lands. Change 3 landed alone, so today the withdrawable custody leg still
-- debits L1 -- the wrong sign for a liability inflow -- and the X4 counterpart
-- does not offset it.
--
-- WHY THE TRIGGER MUST MOVE IN THE SAME TRANSACTION
-- ledger_account_map is not purely reporting. trg_enforce_ledger_group_mapped_
-- balance evaluates every new group against the BASE mapping with no synthetic
-- legs, so it and sofp_ledger_legs disagree about what "balanced" means for
-- this population. Measured over all 2,976 groups carrying one of the three
-- categories:
--
--   change applied                      unbalanced groups (trigger's view)
--   ----------------------------------  ----------------------------------
--   nothing (today)                     591
--   trigger X4 counterpart alone        884   <-- worse
--   mapping flip alone                1,240   <-- much worse
--   both together                       235   <-- pre-existing only
--
-- Neither half is safe on its own. Applied together, every group the X4
-- counterpart covers balances exactly:
--
--   gated groups (X4 applies)   1,005 groups   356 unbalanced / (1,362,957,550)
--                                              ->   0 unbalanced / 0
--   not gated (no X4)           1,971 groups   235 unbalanced /    431,360,852
--                                              -> 235 unbalanced /    431,360,852
--                                                 (unchanged -- see SCOPE)
--
-- SCOPE / WHAT THIS DOES NOT FIX
-- The 235 non-gated groups stay exactly as they are. They are unbalanced in the
-- trigger's view today for a different reason: the trigger lacks the resolver's
-- account overrides and its float_backed_collection_counterpart (A5 + L4)
-- synthetic. That is the same reason 337 agent_collections and 33
-- deposit_requests groups sit in ledger_mapped_balance_violations while being
-- perfectly balanced on the published balance sheet. Closing that gap means
-- teaching the trigger the whole resolver and is deliberately NOT attempted
-- here. This migration changes the trigger in exactly one respect: the X4
-- counterpart, gated identically to sofp_ledger_legs.synth_reclass.
--
-- SAFETY
--   mapped_balance_mode is 'log' and 0 of the 649 affected groups carries a
--   treasury category, so the trigger cannot RAISE on this population either
--   before or after. No posting path can be blocked by this change.
--   No general_ledger row, wallet balance, tenant repayment, collection or
--   other subledger record is read for update, written or deleted.
--
-- EXPECTED EFFECT ON REPORTED BALANCES (base mapping, as at 2026-09-23 12:00Z)
--   A1 Cash and Bank      778,224,618  unchanged  (no A1 mapping touched)
--   A5 Cash in transit    754,293,855  unchanged
--   A2 Agent float        645,297,784  unchanged  (flip touches L1 legs only)
--   L1 Wallet custody   (1,228,005,898) -> (2,119,054,020)
--      i.e. 891,048,122 of customer custody returns to the liability where it
--      belongs, which is the entire point of the correction.

BEGIN;

-- ---------------------------------------------------------------- part 1/2
-- Teach the enforcement trigger the same X4 counterpart the resolver injects.
-- Identical to the live function except for the `sh` CTE and the UNION ALL
-- branch in `legs`.
CREATE OR REPLACE FUNCTION public.enforce_ledger_group_mapped_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cutoff timestamptz; v_first timestamptz; v_mode text;
  v_dr numeric := 0; v_cr numeric := 0; v_resid numeric;
  v_has_treasury boolean := false; v_shape text; v_src text;
BEGIN
  IF NEW.transaction_group_id IS NULL THEN RETURN NEW; END IF;

  SELECT enforce_from, COALESCE(mapped_balance_mode,'log')
    INTO v_cutoff, v_mode FROM public.ledger_integrity_config WHERE id = true;
  IF v_cutoff IS NULL THEN v_cutoff := now(); END IF;

  SELECT MIN(created_at) INTO v_first FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id;
  -- Legacy gate: identical to the existing raw-direction control. Historical
  -- groups are never re-judged and are never silently repaired.
  IF v_first IS NULL OR v_first < v_cutoff THEN RETURN NEW; END IF;

  WITH raw AS (
    SELECT gl.direction dir, gl.amount amt, gl.source_table st, gl.ledger_scope sc,
           gl.category category,
           gl.ledger_scope||'.'||gl.category AS posting,
           COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket='float'   THEN 'A2'
                  WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket='advance' THEN 'A4'
                  WHEN gl.ledger_scope='wallet'                                THEN 'L1'
                  ELSE 'A9' END) AS acct,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope='wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS dw
    FROM public.general_ledger gl
    LEFT JOIN public.ledger_account_map mb ON mb.ledger_scope=gl.ledger_scope AND mb.category=gl.category
          AND mb.wallet_bucket IS NOT NULL AND mb.wallet_bucket=gl.wallet_bucket
    LEFT JOIN public.ledger_account_map mw ON mw.ledger_scope=gl.ledger_scope AND mw.category=gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.transaction_group_id = NEW.transaction_group_id
  ), sh AS (
    SELECT count(*) FILTER (WHERE sc='wallet')                                  AS nw,
           count(*) FILTER (WHERE sc='wallet'   AND acct='A2')                  AS na2,
           count(*) FILTER (WHERE sc='wallet'   AND acct='L1')                  AS nl1,
           count(*) FILTER (WHERE sc='platform')                                AS np,
           count(*) FILTER (WHERE sc='platform' AND category='system_balance_correction') AS nsbc
    FROM raw
  ), legs AS (
    SELECT dir, amt, st, posting, acct, dw, category FROM raw
    UNION ALL
    -- BUCKET RECLASS COUNTERPART: mirrors sofp_ledger_legs.synth_reclass exactly
    -- -- same gate, same two legs, same sign. Emitting these with dw='cash_in'
    -- makes a cash_in leg a debit and a cash_out leg a credit, which is the
    -- behaviour the resolver's explicit dr/cr columns produce.
    SELECT r.dir, r.amt, r.st,
           'reconciliation.bucket_reclass_counterpart', 'X4', 'cash_in',
           'bucket_reclass_counterpart'
    FROM raw r CROSS JOIN sh
    CROSS JOIN LATERAL (VALUES (1),(2)) AS v(i)
    WHERE r.sc='wallet' AND r.acct='L1'
      AND r.category IN ('bucket_reclass_in','bucket_reclass_out','wallet_transfer')
      AND sh.nw=2 AND sh.na2=1 AND sh.nl1=1 AND (sh.np=0 OR sh.np=sh.nsbc)
  )
  SELECT COALESCE(SUM(CASE WHEN dir=dw THEN amt ELSE 0 END),0),
         COALESCE(SUM(CASE WHEN dir=dw THEN 0 ELSE amt END),0),
         bool_or(category IN ('treasury_fee_recognised','treasury_allocated','fee_receivable_created',
                              'partner_reward_accrued','agent_commission_accrued','treasury_net_revenue')),
         string_agg(DISTINCT posting||'->'||acct||'/'||CASE WHEN dir=dw THEN 'DR' ELSE 'CR' END, ' + '),
         MIN(st)
    INTO v_dr, v_cr, v_has_treasury, v_shape, v_src
  FROM legs;

  v_resid := v_dr - v_cr;
  IF abs(v_resid) <= 0.5 THEN RETURN NEW; END IF;

  -- New Landlord Flow -> Treasury postings have no legacy population, so they
  -- are ALWAYS enforced regardless of mode.
  IF v_has_treasury OR v_mode = 'enforce' THEN
    RAISE EXCEPTION 'Ledger group % fails mapped double-entry: debits % <> credits % (residual %). Shape: %',
      NEW.transaction_group_id, v_dr, v_cr, v_resid, v_shape
      USING HINT = 'Every group must balance on MAPPED accounting treatment, not just raw cash_in/cash_out.';
  END IF;

  INSERT INTO public.ledger_mapped_balance_violations
    (transaction_group_id, mapped_debits, mapped_credits, residual, source_table, leg_shape)
  VALUES (NEW.transaction_group_id, v_dr, v_cr, v_resid, v_src, v_shape)
  ON CONFLICT (transaction_group_id) DO UPDATE
    SET mapped_debits=EXCLUDED.mapped_debits, mapped_credits=EXCLUDED.mapped_credits,
        residual=EXCLUDED.residual, leg_shape=EXCLUDED.leg_shape, detected_at=now();
  RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------- part 2/2
-- Change 2 of the design audit: a custody inflow must credit L1.
DO $flip$
DECLARE v_n int; v_before int; v_unbal int;
BEGIN
  SELECT count(*) INTO v_before FROM public.ledger_account_map;

  SELECT count(*) INTO v_n FROM public.ledger_account_map
   WHERE ledger_scope='wallet' AND wallet_bucket='withdrawable'
     AND category IN ('bucket_reclass_in','bucket_reclass_out')
     AND account_code='L1' AND debit_when='cash_in';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'ABORT: expected 2 withdrawable bucket_reclass rows at cash_in, found %', v_n
      USING ERRCODE='55000';
  END IF;

  UPDATE public.ledger_account_map SET debit_when='cash_out'
   WHERE ledger_scope='wallet' AND wallet_bucket='withdrawable'
     AND category IN ('bucket_reclass_in','bucket_reclass_out')
     AND account_code='L1' AND debit_when='cash_in';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'ABORT: updated % rows, expected exactly 2', v_n USING ERRCODE='55000';
  END IF;

  IF (SELECT count(*) FROM public.ledger_account_map) <> v_before THEN
    RAISE EXCEPTION 'ABORT: mapping row count changed' USING ERRCODE='55000';
  END IF;

  -- The float-side rows must NOT move: they are already correct.
  IF (SELECT count(*) FROM public.ledger_account_map
       WHERE ledger_scope='wallet' AND wallet_bucket='float'
         AND category IN ('bucket_reclass_in','bucket_reclass_out')
         AND account_code='A2' AND debit_when='cash_in') <> 2 THEN
    RAISE EXCEPTION 'ABORT: float-side bucket_reclass rows altered' USING ERRCODE='55000';
  END IF;

  -- The partner_funding correction applied on 2026-09-23 must survive.
  IF NOT EXISTS (SELECT 1 FROM public.ledger_account_map
                  WHERE ledger_scope='wallet' AND category='partner_funding' AND wallet_bucket='float'
                    AND account_code='A2' AND debit_when='cash_out') THEN
    RAISE EXCEPTION 'ABORT: partner_funding float mapping regressed' USING ERRCODE='55000';
  END IF;

  -- Every group the X4 counterpart covers must now balance on the trigger's view.
  WITH pop AS (
    SELECT DISTINCT transaction_group_id AS gid FROM public.general_ledger
     WHERE transaction_group_id IS NOT NULL AND ledger_scope='wallet'
       AND wallet_bucket='withdrawable' AND category IN ('bucket_reclass_in','bucket_reclass_out')),
  raw AS (
    SELECT p.gid, gl.ledger_scope sc, gl.category cat, gl.direction dir, gl.amount amt,
      COALESCE(mb.account_code, mw.account_code,
        CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket='float' THEN 'A2'
             WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket='advance' THEN 'A4'
             WHEN gl.ledger_scope='wallet' THEN 'L1' ELSE 'A9' END) AS acct,
      COALESCE(mb.debit_when, mw.debit_when,
        CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
             WHEN gl.ledger_scope='wallet' THEN 'cash_out' ELSE 'cash_in' END) AS dw
    FROM pop p JOIN public.general_ledger gl ON gl.transaction_group_id=p.gid
    LEFT JOIN public.ledger_account_map mb ON mb.ledger_scope=gl.ledger_scope AND mb.category=gl.category
          AND mb.wallet_bucket IS NOT NULL AND mb.wallet_bucket=gl.wallet_bucket
    LEFT JOIN public.ledger_account_map mw ON mw.ledger_scope=gl.ledger_scope AND mw.category=gl.category
          AND mw.wallet_bucket IS NULL),
  sh AS (SELECT gid, count(*) FILTER (WHERE sc='wallet') nw,
                count(*) FILTER (WHERE sc='wallet' AND acct='A2') na2,
                count(*) FILTER (WHERE sc='wallet' AND acct='L1') nl1,
                count(*) FILTER (WHERE sc='platform') np,
                count(*) FILTER (WHERE sc='platform' AND cat='system_balance_correction') nsbc
         FROM raw GROUP BY gid),
  allv AS (
    SELECT r.gid, CASE WHEN r.dir=r.dw THEN r.amt ELSE -r.amt END AS s FROM raw r
    UNION ALL
    SELECT r.gid, CASE WHEN r.dir='cash_in' THEN r.amt ELSE -r.amt END
    FROM raw r JOIN sh ON sh.gid=r.gid CROSS JOIN LATERAL (VALUES (1),(2)) v(i)
    WHERE r.sc='wallet' AND r.acct='L1'
      AND r.cat IN ('bucket_reclass_in','bucket_reclass_out','wallet_transfer')
      AND sh.nw=2 AND sh.na2=1 AND sh.nl1=1 AND (sh.np=0 OR sh.np=sh.nsbc))
  SELECT count(*) INTO v_unbal
    FROM (SELECT gid FROM allv GROUP BY gid HAVING abs(sum(s)) > 0.5) s;
  IF v_unbal <> 0 THEN
    RAISE EXCEPTION 'ABORT: % bucket_reclass groups unbalanced after the change', v_unbal
      USING ERRCODE='55000';
  END IF;

  RAISE NOTICE 'Trigger aligned with the X4 counterpart; 2 withdrawable mapping rows flipped to cash_out. No ledger row written.';
END
$flip$;

COMMIT;
