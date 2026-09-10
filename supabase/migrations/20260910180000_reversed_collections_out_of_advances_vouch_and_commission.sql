-- Take reversed collections out of everything that sizes money, and report
-- commission NET instead of gross.
--
-- Continues 20260910160000 (which made the reversal a real `reversed_at`
-- column and fixed three reporting RPCs) and 20260910170000 (credit limits).
-- This one closes the remaining money-sizing readers and the commission bug.
--
-- ============================================================ what was wrong
--
-- 1. FIVE functions still priced money off collections that had been reversed:
--
--      get_agent_advance_potential        get_agent_advance_potential_for
--      get_agent_advance_limits           get_agent_advance_repayment_monitor
--      recompute_agent_earned_vouch (both overloads)
--
--    All read lifetime totals, where the distortion is worst: Katongole
--    James's collections read 12,478,260 against a genuine 6,580,892 - 47% of
--    his apparent record was money that had been taken back.
--
-- 2. COMMISSION was reported gross. `agent_reverse_tenant_allocation` already
--    posts a reversal correctly - same category, direction cash_out - but
--    every reader filtered
--
--        direction IN ('cash_in','credit')
--
--    and so ignored every commission reversal ever made. Not just this
--    incident's: any reversal, at any time, was invisible to the totals.
--
-- ================================================================= the fixes
--
-- Each function gets `reversed_at IS NULL` on its collections read. Commission
-- aggregations switch to a signed sum
--
--     sum(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END)
--
-- with cash_out/debit admitted to the filter, in all four places in
-- get_agent_ops_overview (commission_curr, commission_prev, the trend `comm`
-- CTE, the top-performers `commissions` CTE).
--
-- A reversal now lands in the period it was MADE, so a window can legitimately
-- show a negative commission if a reversal falls in it and the original credit
-- does not. That is the honest treatment; hiding it is what caused this.
--
-- ============================================== applied and verified in prod
--
-- Vouch is the largest exposure found - the multiplier is 2x lifetime
-- collections, so the phantom money was worth double its face value:
--
--   Agent                Vouch before      after         removed
--   Katongole James        24,956,520   13,161,784    -11,794,736
--   Akampurira Onesmus     21,307,200   20,707,200       -600,000
--   Saka Homi Melvin       16,537,690   16,350,354       -187,336
--                                                     -12,582,072
--
-- which is exactly 2 x the 6,291,036 of reversed collections.

-- 1. Advance potential (fleet) --------------------------------------------
-- coll CTE: WHERE ac.reversed_at IS NULL
-- 2. Advance potential (single agent) -------------------------------------
-- coll CTE: AND ac.reversed_at IS NULL
-- 3. Advance limits preview -----------------------------------------------
-- coll CTE: WHERE ac.reversed_at IS NULL, so the preview matches
--           recalculate_credit_limit, which is what is actually stored.
-- 4. Advance repayment monitor --------------------------------------------
-- ct lateral: AND c.reversed_at IS NULL
-- 5. Earned vouch, both overloads -----------------------------------------
-- AND reversed_at IS NULL on the lifetime sum.
--
-- The bodies are large and are deployed outside this repository, so rather
-- than restating ~30KB of unchanged SQL here, the predicate added to each is
-- listed above and asserted below. The live definitions were updated on
-- 2026-09-10 and the assertion fails loudly if any of them is redeployed
-- without its filter.

-- 6. Re-price the agents holding reversed collections ----------------------
SELECT public.recalculate_credit_limit(a.agent_id)
FROM (SELECT DISTINCT agent_id FROM public.agent_collections WHERE reversed_at IS NOT NULL) a
WHERE a.agent_id IS NOT NULL;

SELECT public.recompute_agent_earned_vouch(a.agent_id, 'manual_recompute'::text, NULL::uuid, NULL::numeric)
FROM (SELECT DISTINCT agent_id FROM public.agent_collections WHERE reversed_at IS NOT NULL) a
WHERE a.agent_id IS NOT NULL;

-- 7. Post-conditions --------------------------------------------------------
DO $verify$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname || COALESCE('(' || pg_get_function_identity_arguments(p.oid) || ')', ''), ', ')
    INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('get_agent_advance_potential','get_agent_advance_potential_for',
                       'get_agent_advance_limits','get_agent_advance_repayment_monitor',
                       'recompute_agent_earned_vouch','recalculate_credit_limit',
                       'get_agent_ops_overview','get_agent_collections_command_center',
                       'get_agent_collections_coverage')
     AND p.prosrc NOT ILIKE '%reversed_at%';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'these still price money on reversed collections: %', v_bad;
  END IF;

  -- Commission must be reported net, not gross.
  SELECT p.proname INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_agent_ops_overview'
     AND p.prosrc NOT ILIKE '%WHEN direction IN (''cash_in'',''credit'') THEN amount ELSE -amount END%';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'get_agent_ops_overview still reports commission gross';
  END IF;

  -- No agent may be priced above 6% of their GENUINE lifetime collections.
  SELECT string_agg(pr.full_name, ', ') INTO v_bad
    FROM public.credit_access_limits l
    JOIN public.profiles pr ON pr.id = l.user_id
    CROSS JOIN LATERAL (
      SELECT LEAST(COALESCE((SELECT SUM(amount) FROM public.agent_collections
                              WHERE agent_id = l.user_id AND reversed_at IS NULL), 0) * 0.06, 2400000) AS cap
    ) x
   WHERE l.user_id IN (SELECT DISTINCT agent_id FROM public.agent_collections WHERE reversed_at IS NOT NULL)
     AND l.bonus_from_agent_allocations > x.cap + 1;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'credit limits still priced on reversed collections: %', v_bad;
  END IF;
END
$verify$;

-- ===================================================== STILL OPEN, needs a
-- ===================================================== decision, not a patch
--
-- The 589,736.80 commission clawback posted during the 2026-09-10 incident
-- cleanup sits under category `system_balance_correction`, not a commission
-- category, so the netting above cannot see it. Today's commission figure is
-- therefore still overstated by that amount.
--
-- It must NOT be fixed by editing the row. A posted ledger entry is immutable,
-- and `system_balance_correction` is a general CFO-debit bucket - it also
-- carries ROI reversals, wallet retractions and operating costs (9,650,000 on
-- 2026-07-30, 5,300,000 on 2026-08-05), so netting the whole category into
-- commission would be far more wrong than the present error.
--
-- The correct remedy is a compensating pair on ledger row 25a559d9, netting to
-- zero on the wallet so no balance moves:
--
--   cash_in  589,736.80  system_balance_correction  wallet/withdrawable
--   cash_out 589,736.80  agent_commission_earned    wallet/withdrawable
--
-- both classification 'admin_correction' (so they stay out of the agent's own
-- wallet feed) and sharing one transaction_group_id. Writing to the ledger was
-- deliberately not done here without an explicit go-ahead.
