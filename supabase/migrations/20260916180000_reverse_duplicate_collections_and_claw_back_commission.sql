-- Phase 2 of the 2026-09-15 float-gate incident: reverse the duplicate
-- collections and recover what is left of the commission they paid.
--
-- WHAT HAPPENED
-- Between 2026-09-15 and 2026-09-16 the allocator stopped consuming float and
-- the repayment guard silently reverted `amount_repaid`, so an agent's screen
-- never showed progress and the same payment could be submitted over and over.
-- Each submission was a real `agent_collections` row and paid a real 10%
-- commission. See 20260916120000 for the fix.
--
-- MEASURED DAMAGE (both days, deduped on agent+tenant+plan+amount per day)
--   1,327 duplicate rows            UGX 105,425,606 of phantom "collections"
--   commission paid on them         UGX  10,542,560.60
--
-- TENANTS WERE NOT CHARGED TWICE. The same guard failure that caused the loop
-- also kept the duplicates out of `rent_requests.amount_repaid`: zero plans are
-- credited beyond their own total. This migration therefore does NOT touch a
-- single tenant balance. Only the receipt book and the agents' commission.
--
-- RECOVERY, AND THE DECISION BEHIND IT
--   recoverable from wallets   UGX  2,846,236.28   (27%)
--   already withdrawn          UGX  7,696,324.32   (73%)
--
-- 27 of these agents completed 74 withdrawals totalling UGX 46,268,914 across
-- the two days, so most of the commission had left before anyone noticed.
--
-- The instruction (product owner, 2026-09-16) was: take back what is still in
-- the wallets, count the rest as a loss, and put NOBODY into negative balance.
-- So each agent's clawback is capped at their own withdrawable balance and the
-- remainder is written off. No advance, no fee and no debt is created against
-- any agent: `create_overdraft_recovery_advance` would have attached a 33%
-- platform fee, which is a penalty product for an agent who overdrew, and this
-- was not their doing.
--
-- LEDGER SHAPE
-- Mirrors how the 2026-09-10 inversion was unwound ("reversed as system
-- corrections"): a balanced pair of `system_balance_correction` legs,
-- classification `admin_correction`, carrying solvency_bypass_reason
-- `duplicate_reversal` - the code the enum already has for exactly this.
--   CR wallet  system_balance_correction  cash_out   agent's withdrawable falls
--   DR platform system_balance_correction cash_in    contra
-- Float is deliberately untouched: the duplicates never consumed any.
--
-- Verified on a rolled-back transaction against Denis Tushabe:
-- withdrawable 751,820 -> 55,820 (-696,000), float unchanged, not negative.
--
-- REPORTING
-- `reversed_at` is the switch the reporting sweep (20260910160000 ..190000)
-- already reads: get_agent_ops_overview, get_agent_collections_command_center,
-- get_agent_collections_coverage and agent_ops_report_collected all exclude
-- reversed rows today, so marking these rows is what brings the collected
-- figure back from UGX 136.6M to the genuine UGX 39.1M against a 6.08M bill.
-- Three surfaces still do NOT filter and are follow-up work, listed at the end.

DO $fix$
DECLARE
  r record;
  v_grp uuid;
  v_agents int := 0; v_clawed numeric := 0; v_written_off numeric := 0; v_marked int := 0;
BEGIN
  -- Idempotency: this migration moves money, so it refuses to run twice.
  IF EXISTS (SELECT 1 FROM public.general_ledger
              WHERE category = 'system_balance_correction'
                AND solvency_bypass_reason = 'duplicate_reversal'
                AND description LIKE '%2026-09-15/16 float-gate defect%') THEN
    RAISE NOTICE 'Already applied - clawback legs for this incident exist. Nothing done.';
    RETURN;
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  FOR r IN
    WITH s AS (
      SELECT ac.agent_id, ac.amount,
             row_number() OVER (PARTITION BY (ac.created_at AT TIME ZONE 'Africa/Kampala')::date,
                                             ac.agent_id, ac.rent_request_id, ac.amount
                                ORDER BY ac.created_at) AS seq
        FROM public.agent_collections ac
       WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
             IN (date '2026-09-15', date '2026-09-16')
         AND ac.reversed_at IS NULL
    ), over AS (
      SELECT agent_id,
             round(coalesce(sum(amount) FILTER (WHERE seq > 1), 0) * 0.10, 2) AS overpaid
        FROM s GROUP BY agent_id
       HAVING coalesce(sum(amount) FILTER (WHERE seq > 1), 0) > 0
    )
    SELECT o.agent_id,
           o.overpaid,
           round(least(o.overpaid, greatest(coalesce(w.withdrawable, 0), 0)), 2) AS clawback,
           round(o.overpaid - least(o.overpaid,
                 greatest(coalesce(w.withdrawable, 0), 0)), 2)                   AS written_off
      FROM over o
      LEFT JOIN public.wallet_balances_projection w ON w.user_id = o.agent_id
  LOOP
    v_agents := v_agents + 1;
    v_written_off := v_written_off + r.written_off;

    -- Nothing left in the wallet: the whole of this agent's share is the loss.
    CONTINUE WHEN r.clawback < 0.01;

    v_grp := gen_random_uuid();

    INSERT INTO public.general_ledger
      (user_id, amount, direction, category, classification, solvency_bypass_reason,
       source_table, source_id, description, ledger_scope, transaction_group_id)
    VALUES
      (r.agent_id, r.clawback, 'cash_out', 'system_balance_correction', 'admin_correction',
       'duplicate_reversal', 'agent_collections', gen_random_uuid(),
       'Clawback of commission paid on duplicate rent collections (2026-09-15/16 float-gate defect)',
       'wallet', v_grp),
      (r.agent_id, r.clawback, 'cash_in', 'system_balance_correction', 'admin_correction',
       'duplicate_reversal', 'agent_collections', gen_random_uuid(),
       'Contra: commission clawback for duplicate rent collections (2026-09-15/16 float-gate defect)',
       'platform', v_grp);

    v_clawed := v_clawed + r.clawback;
  END LOOP;

  -- Mark the duplicates. Deliberately AFTER the clawback, because the amounts
  -- above are computed from the rows that are still unreversed.
  WITH s AS (
    SELECT ac.id,
           row_number() OVER (PARTITION BY (ac.created_at AT TIME ZONE 'Africa/Kampala')::date,
                                           ac.agent_id, ac.rent_request_id, ac.amount
                              ORDER BY ac.created_at) AS seq
      FROM public.agent_collections ac
     WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
           IN (date '2026-09-15', date '2026-09-16')
       AND ac.reversed_at IS NULL
  )
  UPDATE public.agent_collections ac
     SET reversed_at = now(),
         notes = coalesce(ac.notes, '') ||
                 ' [REVERSED: duplicate submission, 2026-09-15 float-gate defect. No tenant was charged twice.]'
    FROM s
   WHERE s.id = ac.id AND s.seq > 1;

  GET DIAGNOSTICS v_marked = ROW_COUNT;

  RAISE NOTICE 'agents=% clawed_back=% written_off=% duplicate_rows_marked=%',
    v_agents, v_clawed, v_written_off, v_marked;

  IF v_marked <> 1327 THEN
    RAISE WARNING 'expected 1327 duplicate rows, marked % - re-check before trusting the figures', v_marked;
  END IF;
END $fix$;

-- FOLLOW-UP, NOT DONE HERE
-- These three still read `agent_collections` without excluding reversed rows,
-- so they will keep showing the duplicated totals until they are swept the way
-- 20260910190000 describes - individually, by hand, never by blind regex:
--   * agent_ops_report_team_collections
--   * get_agent_ops_comprehensive_report
--   * get_agent_products_services_report
