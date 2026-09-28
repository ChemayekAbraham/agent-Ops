-- Take the reversed duplicate collections back out of the tenants' plan balances.
--
-- WHAT 20260916180000 GOT WRONG, AND WHY IT MATTERED
--
-- That migration reversed 1,210 duplicate collections and stated that the
-- tenants were untouched, on the evidence that "zero plans are credited beyond
-- their own total". Staying under `total_repayment` is not the same as not
-- being credited. It is possible to be credited 2,537,000 you never paid and
-- still sit under a 2,680,000 ceiling — and one plan does exactly that.
--
-- 25 plans carry an `amount_repaid` equal to live + reversed collections TO
-- THE SHILLING. Every reversal behind them is dated 2026-09-16, and none of
-- them appears in the `repayment_restored_after_guard_drop` audit set, so this
-- is the duplicate sweep and not the restore that followed it.
--
--   plans                                    25
--   duplicate credit removed      UGX  8,180,000
--   plans reopened from completed             1
--
--   Worst case: 59 reversed rows worth 2,537,000 against 64,000 of real
--   collections, on a plan reading 2,601,000 of 2,680,000. A tenant shown 97%
--   repaid who has actually paid 64,000.
--
-- WHY THE MATCH RULE IS EXACT AND NOT "ANYTHING ABOVE LIVE COLLECTIONS"
--
-- Widened to "amount_repaid exceeds live collections on a plan that has
-- reversals", it is 57 plans and 19,090,568. That wider set is an upper bound,
-- not a diagnosis: `amount_repaid` is also written by deposit settlement and
-- tenant self-payment, neither of which leaves an `agent_collections` row, so
-- a plan can legitimately sit above its collections. Only the exact
-- live + reversed match is provable, so only the exact match is corrected. The
-- rest stays visible in the monitor (`plan_balance_holds_reversed`) for a human
-- to judge.
--
-- The rule survives new collections: a payment of X raises both `amount_repaid`
-- and `live` by X, so the equality holds and the plan neither drops out of the
-- set nor gets over-corrected. Each plan is set to its OWN live collections at
-- the moment of the update rather than to a precomputed number.
--
-- WHY THIS POSTS NOTHING TO THE LEDGER
--
-- The books are already right. 20260916220000 contra'd the duplicates in
-- aggregate on 2026-09-16 — A5 custody -92,656,683, A3 receivable +92,656,683
-- — so the ledger already says these tenants still owe the money. It is the
-- operational column that disagreed. This migration moves that column, and the
-- status that follows from it, and nothing else. Posting anything here would
-- count the same money twice, which is the same reasoning 20260916200000 gave
-- for moving a balance without a journal.
--
-- WHAT THIS DOES AND DOES NOT MOVE
--
-- Proved on a rolled-back transaction against production: arrears are
-- UNCHANGED at 52,845,349. `v_rent_plan_arrears` measures the pinned bill
-- against the receipt book, and the receipt book was corrected on 16 September,
-- so the arrears figure was never wrong. Chase queues and the call-centre list
-- do not grow.
--
-- What does move: what each of these 25 tenants still owes rises by their share
-- of the 8,180,000, their progress bar falls, and the one completed plan
-- re-enters daily billing. Those 25 tenants will be collected from for longer.
-- That is the point — they were credited with money the platform reversed.
--
-- REVERSIBLE. Every plan gets an `audit_logs` row carrying its old and new
-- `amount_repaid` and status, so the whole batch can be put back exactly as it
-- was. That is also the guard against running twice.

DO $fix$
DECLARE
  r          record;
  v_plans    int     := 0;
  v_removed  numeric := 0;
  v_reopened int     := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_logs
              WHERE action_type = 'plan_balance_duplicate_credit_removed') THEN
    RAISE NOTICE 'Already applied - duplicate credit was removed from plan balances previously. Nothing done.';
    RETURN;
  END IF;

  FOR r IN
    WITH c AS (
      SELECT ac.rent_request_id AS rr_id,
             COALESCE(sum(ac.amount) FILTER (
               WHERE ac.reversed_at IS NULL
                 AND COALESCE(ac.notes,'') NOT ILIKE '%[REVERSED:%'), 0) AS live,
             COALESCE(sum(ac.amount) FILTER (
               WHERE ac.reversed_at IS NOT NULL
                  OR COALESCE(ac.notes,'') ILIKE '%[REVERSED:%'), 0) AS rev,
             count(*) FILTER (WHERE ac.reversed_at IS NOT NULL) AS rev_rows
      FROM public.agent_collections ac
      WHERE ac.rent_request_id IS NOT NULL
      GROUP BY ac.rent_request_id
    )
    SELECT rr.id, rr.status, rr.tenant_id, rr.agent_id,
           rr.amount_repaid, rr.total_repayment,
           c.live, c.rev, c.rev_rows
    FROM c
    JOIN public.rent_requests rr ON rr.id = c.rr_id
    WHERE c.rev > 0
      AND rr.amount_repaid > c.live
      -- Exact live + reversed match only. See the header.
      AND rr.amount_repaid BETWEEN c.live + c.rev - 1 AND c.live + c.rev + 1
    ORDER BY c.rev DESC
  LOOP
    INSERT INTO public.audit_logs (
      action_type, table_name, record_id, action, reason, old_values, new_values
    ) VALUES (
      'plan_balance_duplicate_credit_removed',
      'rent_requests',
      r.id::text,
      'correct_amount_repaid',
      'Duplicate collections of 2026-09-15/16 were reversed in the receipt book '
        || 'and contra''d in the ledger, but were left inside this plan balance.',
      jsonb_build_object(
        'amount_repaid', r.amount_repaid,
        'status',        r.status),
      jsonb_build_object(
        'amount_repaid',       r.live,
        'status',              CASE WHEN r.status = 'completed'
                                     AND r.live < COALESCE(r.total_repayment, 0)
                                    THEN 'repaying' ELSE r.status END,
        'reversed_removed',    r.amount_repaid - r.live,
        'reversed_rows',       r.rev_rows,
        'live_collections',    r.live,
        'total_repayment',     r.total_repayment)
    );

    UPDATE public.rent_requests
       SET amount_repaid = r.live,
           status = CASE WHEN status = 'completed'
                          AND r.live < COALESCE(total_repayment, 0)
                         THEN 'repaying' ELSE status END,
           updated_at = now()
     WHERE id = r.id;

    v_plans   := v_plans + 1;
    v_removed := v_removed + (r.amount_repaid - r.live);
    IF r.status = 'completed' AND r.live < COALESCE(r.total_repayment, 0) THEN
      v_reopened := v_reopened + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Plan balances corrected: % plans, UGX % of duplicate credit removed, % reopened.',
    v_plans, v_removed, v_reopened;
END
$fix$;
