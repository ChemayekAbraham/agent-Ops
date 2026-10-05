-- APPLIED TO PRODUCTION 2026-09-23 (CFO-approved, read-only verification first).
--
-- Corrects the wallet/partner_funding/float mapping row added earlier the same
-- day, which was created with debit_when = 'cash_in'.
--
-- WHY IT WAS WRONG
-- Every partner_funding float group is exactly two legs:
--     platform  partner_funding        cash_in  -> CR L2   (partner capital held)
--     platform  pending_portfolio_topup cash_in -> CR L6   (top-up awaiting application)
--     wallet    partner_funding float  cash_out -> ?
-- With debit_when = 'cash_in' the wallet leg (direction cash_out) resolved to a
-- CREDIT, so the group was credit-against-credit and did not balance. A2 -- an
-- asset -- carried a CREDIT balance of 120,584,144 as a result.
--
-- The design audit predicted a DEBIT to A2 and was right about the direction;
-- the debit_when value it specified contradicted its own predicted sign. The
-- leg direction is cash_out, so debit_when must be cash_out for it to debit.
--
-- VERIFIED BEFORE APPLYING (read-only, full ledger):
--   189 wallet float partner_funding legs across 189 groups.
--   Before: debits 6,200,000   credits 924,101,928  (residual -917,901,928)
--   After:  debits 465,150,964 credits 465,150,964  (residual 0)
--   0 of 189 groups carry a treasury category, so trg_enforce_ledger_group_
--   mapped_balance cannot RAISE on them; mapped_balance_mode is 'log'.
--
-- VERIFIED AFTER APPLYING:
--   A1 Cash and Bank       778,224,618 -> 778,224,618  (unchanged)
--   A5 Cash in transit     754,293,855 -> 754,293,855  (unchanged)
--   A2 Agent float        (120,584,144) ->  645,297,784 (now a proper asset)
--   L1, L2, L6 unchanged. 189/189 groups balance. 0 residual.
--
-- SCOPE: one mapping row. No general_ledger row, wallet balance, tenant
-- repayment, collection or other subledger record is read for update, written
-- or deleted. ledger_account_map is consumed only by reporting functions and by
-- trg_enforce_ledger_group_mapped_balance, none of which reach
-- apply_wallet_movement, wallet_balances_projection or wallets_physical.
--
-- NOT IN THIS MIGRATION: the bucket_reclass_* withdrawable rows remain at
-- debit_when = 'cash_in'. They are deferred until the enforcement trigger is
-- taught the same X4 counterpart the resolver injects -- flipping them first
-- would make 639 groups fail the trigger's balance test.

BEGIN;

DO $fix$
DECLARE v_n int; v_before int; v_unbal int;
BEGIN
  SELECT count(*) INTO v_before FROM public.ledger_account_map;

  SELECT count(*) INTO v_n FROM public.ledger_account_map
   WHERE ledger_scope='wallet' AND category='partner_funding' AND wallet_bucket='float'
     AND account_code='A2' AND debit_when='cash_in';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ABORT: target row not in the expected state (% matching rows)', v_n USING ERRCODE='55000';
  END IF;

  UPDATE public.ledger_account_map SET debit_when='cash_out'
   WHERE ledger_scope='wallet' AND category='partner_funding' AND wallet_bucket='float'
     AND account_code='A2' AND debit_when='cash_in';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ABORT: updated % rows, expected exactly 1', v_n USING ERRCODE='55000';
  END IF;

  IF (SELECT count(*) FROM public.ledger_account_map) <> v_before THEN
    RAISE EXCEPTION 'ABORT: mapping row count changed' USING ERRCODE='55000';
  END IF;

  -- the bucket-agnostic wallet partner_funding row (withdrawable/other) must survive
  IF NOT EXISTS (SELECT 1 FROM public.ledger_account_map
                  WHERE ledger_scope='wallet' AND category='partner_funding' AND wallet_bucket IS NULL
                    AND account_code='L1' AND debit_when='cash_out') THEN
    RAISE EXCEPTION 'ABORT: bucket-agnostic wallet partner_funding row altered' USING ERRCODE='55000';
  END IF;

  WITH pop AS (
    SELECT DISTINCT transaction_group_id AS gid FROM public.general_ledger
     WHERE transaction_group_id IS NOT NULL AND ledger_scope='wallet'
       AND category='partner_funding' AND wallet_bucket='float'),
  legs AS (
    SELECT p.gid, gl.direction AS dir, gl.amount AS amt,
      COALESCE(mb.debit_when, mw.debit_when,
        CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
             WHEN gl.ledger_scope='wallet' THEN 'cash_out' ELSE 'cash_in' END) AS dw
    FROM pop p JOIN public.general_ledger gl ON gl.transaction_group_id=p.gid
    LEFT JOIN public.ledger_account_map mb ON mb.ledger_scope=gl.ledger_scope AND mb.category=gl.category
          AND mb.wallet_bucket IS NOT NULL AND mb.wallet_bucket=gl.wallet_bucket
    LEFT JOIN public.ledger_account_map mw ON mw.ledger_scope=gl.ledger_scope AND mw.category=gl.category
          AND mw.wallet_bucket IS NULL)
  SELECT count(*) INTO v_unbal FROM (
    SELECT gid FROM legs GROUP BY gid
     HAVING abs(sum(CASE WHEN dir=dw THEN amt ELSE -amt END)) > 0.5) s;
  IF v_unbal <> 0 THEN
    RAISE EXCEPTION 'ABORT: % partner_funding groups still unbalanced', v_unbal USING ERRCODE='55000';
  END IF;

  RAISE NOTICE 'wallet/partner_funding/float debit_when cash_in -> cash_out. 1 row. No ledger row written.';
END
$fix$;

COMMIT;
