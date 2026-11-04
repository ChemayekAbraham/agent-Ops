-- 2026-11-04: Spiro motorcycle releases recognised in A13 (CFO rule 2026-11-04: money released for merchandise on behalf
-- of an agent is recognised in full as a receivable at release; motorcycles in A13). Two cases only:
--   ALPHA SSEMA  - order a544f375, plan 93d95269, released 710,000 on 2026-09-17 (group 77e52832, key
--                  bike-lease-disbursement-a544f375-...) into the agent's withdrawable wallet.
--   PIUS MATA    - order a3228b88, plan bfe58c27, released 710,000 on 2026-09-10 (group 3b9350ea, key
--                  bike-lease-disbursement-a3228b88-...) into the agent's withdrawable wallet.
-- Today each release sits in X1 (DR equipment_expense 710,000), and A13 carries 500,000 against equity (E3: the 22 Sep
-- opening of 710,000 less correction J7 of 210,000), less principal recovered. Production apply needs explicit CFO approval.
-- ACCOUNTING ONLY: no wallet leg, payment, refund, collection, deduction, plan / lease balance or status change.
--   1. Per bike, group <key>:RECOGNISE - DR A13 bike_recovery_repayment 710,000 / CR X1 equipment_expense 710,000:
--      the release becomes the receivable (the same entry correction J3 made for Abraham Chelimo's bike, 27842d46).
--   2. Per bike, group <key>:OPENING - DR E3 receivable_restatement_equity 500,000 / CR A13 bike_recovery_receivable_opening
--      500,000: removes the equity-funded opening balance that stood in for the receivable (the same shape as J7).
--      Net per bike: A13 +210,000 (gross 710,000 = the release), X1 -710,000, E3 0 for the order.
--   3. Per plan, the accounting split only: principal_total 500,000 -> 710,000 and fee_total 910,000 -> 700,000. The
--      total the agent repays (1,410,000), the outstanding balance, the daily amounts and the deductions are unchanged;
--      only how future collections are split between A13 (principal) and R1 (charges) changes, so A13 clears exactly
--      when the plan is paid. Without it 210,000 of A13 would never clear.
-- Keys: spiro_release_a13_20261104:<sale>:RECOGNISE / :OPENING. Not repeatable (the preflight refuses a second run).
-- Rollback: supabase/rollbacks/20261104210000_spiro_bike_release_a13_corrections.rollback.sql (plan split only; the
-- entries stay - append-only - and are reversed only by new entries).
-- Tests: src/test/spiroBikeReleaseA13.test.ts. Dry run: supabase/tests/spiro_bike_release_a13_dryrun.sql.
-- TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
-- no collection can run on these plans between the checks and the posting
LOCK TABLE public.merchandise_recovery_plans IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _spiro_fix ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('a544f375-e454-4ed6-a794-81a500916c8a'::uuid, '93d95269-34da-45f0-9845-fff6b7312220'::uuid,
   '77e52832'::text, 'c1597078'::text, 'ALPHA SSEMA'::text),
  ('a3228b88-6f28-459b-9ef4-48bfd11d3e44'::uuid, 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9'::uuid,
   '3b9350ea'::text, '7be1c065'::text, 'PIUS MATA'::text)
) v(sale, plan, release_gid8, opening_gid8, who);

DO $pre$
DECLARE r record; v_bad text := ''; v_n int; v_rel uuid; v_open uuid; v_net jsonb; v_e3 numeric; v_x1 numeric; v_a13 numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.general_ledger WHERE left(COALESCE(idempotency_key, ''), 27) = 'spiro_release_a13_20261104:') THEN
    RAISE EXCEPTION 'spiro A13 correction: already applied';
  END IF;
  FOR r IN SELECT * FROM _spiro_fix LOOP
    -- the original release: one group, DR X1 equipment_expense 710,000 + the agent's withdrawable wallet credit 710,000
    SELECT g.transaction_group_id INTO v_rel FROM public.general_ledger g
      WHERE g.idempotency_key = 'bike-lease-disbursement-' || r.sale::text AND g.ledger_scope = 'platform'
        AND g.category = 'equipment_expense' AND g.direction = 'cash_out' AND g.amount = 710000
        AND left(g.transaction_group_id::text, 8) = r.release_gid8;
    SELECT count(*) INTO v_n FROM public.general_ledger g
      WHERE g.transaction_group_id = v_rel AND ((g.ledger_scope = 'platform' AND g.category = 'equipment_expense' AND g.direction = 'cash_out' AND g.amount = 710000)
         OR (g.ledger_scope = 'wallet' AND g.category = 'agent_advance_credit' AND g.direction = 'cash_in' AND g.amount = 710000
             AND g.wallet_bucket = 'withdrawable' AND g.user_id = (SELECT customer_id FROM public.merchandise_sales WHERE id = r.sale)));
    IF v_rel IS NULL OR v_n <> 2 OR (SELECT count(*) FROM public.general_ledger WHERE transaction_group_id = v_rel) <> 2 THEN
      v_bad := v_bad || r.who || ': release; ';
    END IF;
    -- the 22 Sep opening (A13 710,000 vs E3) and correction J7 (210,000 back): 500,000 left in A13 from E3
    SELECT g.transaction_group_id INTO v_open FROM public.general_ledger g
      WHERE g.idempotency_key LIKE 'A13\_restate:' || r.plan::text || ':%' AND left(g.transaction_group_id::text, 8) = r.opening_gid8 LIMIT 1;
    IF v_open IS NULL
       OR (SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END), 0) FROM public.general_ledger g
             WHERE g.source_table = 'merchandise_recovery_plans' AND g.source_id = r.plan AND g.category = 'bike_recovery_receivable_opening') <> 500000
       OR NOT EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = 'merch_a12_a13_correction_20261104:' || r.plan::text || ':J7'
                        AND g.category = 'bike_recovery_receivable_opening' AND g.direction = 'cash_out' AND g.amount = 210000) THEN
      v_bad := v_bad || r.who || ': opening / J7; ';
    END IF;
    -- nothing has recognised the release yet: no A13 debit from bike_recovery_repayment on the order, plan or lease
    IF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.ledger_scope = 'platform' AND g.category = 'bike_recovery_repayment' AND g.direction = 'cash_out'
                 AND ((g.source_table = 'merchandise_sales' AND g.source_id = r.sale) OR (g.source_table = 'merchandise_recovery_plans' AND g.source_id = r.plan)
                      OR (g.source_table = 'agent_bike_leases' AND g.source_id IN (SELECT id FROM public.agent_bike_leases WHERE sale_id = r.sale)))) THEN
      v_bad := v_bad || r.who || ': already recognised; ';
    END IF;
    -- the order still leaves X1 710,000 and E3 -500,000; A13 = 500,000 less the principal the plan records as recovered
    SELECT COALESCE(sum(CASE WHEN g.category = 'equipment_expense' THEN CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END END), 0),
           COALESCE(sum(CASE WHEN g.category = 'receivable_restatement_equity' THEN CASE WHEN g.direction = 'cash_out' THEN -g.amount ELSE g.amount END END), 0)
      INTO v_x1, v_e3
    FROM public.general_ledger g
    WHERE (g.source_table = 'merchandise_sales' AND g.source_id = r.sale) OR (g.source_table = 'merchandise_recovery_plans' AND g.source_id = r.plan);
    v_net := public._merch_receivable_net(r.sale, ARRAY[r.plan], true);
    v_a13 := (v_net->>'a13')::numeric;
    IF v_x1 <> 710000 OR v_e3 <> -500000
       OR v_a13 <> 500000 - (SELECT COALESCE(principal_recovered, 0) FROM public.merchandise_recovery_plans WHERE id = r.plan) THEN
      v_bad := v_bad || r.who || format(': balances X1 %s E3 %s A13 %s; ', v_x1, v_e3, v_a13);
    END IF;
    -- the plan split this corrects
    IF NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans p WHERE p.id = r.plan AND p.sale_id = r.sale AND p.status = 'active'
                     AND COALESCE(p.is_bike_lease, false) AND p.principal_total = 500000 AND p.fee_total = 910000 AND p.original_amount = 1410000
                     AND COALESCE(p.fee_recovered, 0) < 700000)
       OR NOT EXISTS (SELECT 1 FROM public.merchandise_sales s WHERE s.id = r.sale AND s.disbursed_amount = 710000 AND s.order_status = 'approved') THEN
      v_bad := v_bad || r.who || ': plan / order; ';
    END IF;
  END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'spiro A13 correction: evidence moved - %', v_bad; END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_receivable_net(uuid, uuid[], boolean)')) IS NULL THEN
    RAISE EXCEPTION 'spiro A13 correction: _merch_receivable_net missing';
  END IF;
END $pre$;

-- ---------------------------------------------------------------- the entries
DO $post_entries$
DECLARE r record; v_agent uuid; v_rel uuid; v_open uuid; v_desc text;
BEGIN
  FOR r IN SELECT * FROM _spiro_fix ORDER BY sale LOOP
    SELECT customer_id INTO v_agent FROM public.merchandise_sales WHERE id = r.sale;
    SELECT transaction_group_id INTO v_rel FROM public.general_ledger
      WHERE idempotency_key = 'bike-lease-disbursement-' || r.sale::text LIMIT 1;
    SELECT transaction_group_id INTO v_open FROM public.general_ledger
      WHERE idempotency_key LIKE 'A13\_restate:' || r.plan::text || ':%' LIMIT 1;
    v_desc := 'Correction 2026-11-04 (CFO rule): the 710,000 released for ' || r.who
              || '''s Spiro motorcycle is the motorcycle receivable (A13), not an expense (X1)';
    PERFORM public.create_ledger_transaction(entries => jsonb_build_array(
      jsonb_build_object('user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_out', 'amount', 710000,
        'category', 'bike_recovery_repayment', 'source_table', 'merchandise_recovery_plans', 'source_id', r.plan,
        'reference_id', v_rel::text, 'currency', 'UGX', 'description', v_desc),
      jsonb_build_object('user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_in', 'amount', 710000,
        'category', 'equipment_expense', 'source_table', 'merchandise_recovery_plans', 'source_id', r.plan,
        'reference_id', v_rel::text, 'currency', 'UGX', 'description', v_desc)),
      idempotency_key => 'spiro_release_a13_20261104:' || r.sale::text || ':RECOGNISE');
    v_desc := 'Correction 2026-11-04 (CFO rule): remove the 2026-09-22 equity-funded opening balance for ' || r.who
              || '''s Spiro motorcycle (500,000 left after J7); the receivable is now the release itself';
    PERFORM public.create_ledger_transaction(entries => jsonb_build_array(
      jsonb_build_object('user_id', v_agent, 'ledger_scope', 'bridge', 'direction', 'cash_out', 'amount', 500000,
        'category', 'bike_recovery_receivable_opening', 'source_table', 'merchandise_recovery_plans', 'source_id', r.plan,
        'reference_id', v_open::text, 'currency', 'UGX', 'description', v_desc),
      jsonb_build_object('user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_in', 'amount', 500000,
        'category', 'receivable_restatement_equity', 'source_table', 'merchandise_recovery_plans', 'source_id', r.plan,
        'reference_id', v_open::text, 'currency', 'UGX', 'description', v_desc)),
      idempotency_key => 'spiro_release_a13_20261104:' || r.sale::text || ':OPENING');

    -- 3. the plan's accounting split: principal = the amount released; total repayable, balance and deductions unchanged
    UPDATE public.merchandise_recovery_plans
      SET principal_total = 710000, fee_total = 700000, updated_at = now()
      WHERE id = r.plan AND principal_total = 500000 AND fee_total = 910000;
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (NULL, 'spiro_release_a13_correction', 'merchandise_recovery_plans', r.plan::text,
      'CFO rule 2026-11-04: motorcycle receivable = amount released (710,000); principal_total 500,000 -> 710,000, fee_total 910,000 -> 700,000 (split only)',
      jsonb_build_object('sale_id', r.sale, 'release_group', v_rel, 'opening_group', v_open,
        'keys', jsonb_build_array('spiro_release_a13_20261104:' || r.sale::text || ':RECOGNISE', 'spiro_release_a13_20261104:' || r.sale::text || ':OPENING')));
  END LOOP;
END $post_entries$;

-- ---------------------------------------------------------------- post-check
DO $post$
DECLARE r record; v_bad text := ''; v_net jsonb; v_x1 numeric; v_e3 numeric; v_n int;
BEGIN
  -- 4 groups, two legs each, platform / bridge only, balanced raw and on mapped accounts
  SELECT count(*) INTO v_n FROM (
    SELECT g.transaction_group_id FROM public.general_ledger g
    JOIN public.ledger_account_map m ON m.ledger_scope = g.ledger_scope AND m.category = g.category AND m.wallet_bucket IS NULL
    WHERE left(g.idempotency_key, 27) = 'spiro_release_a13_20261104:'
    GROUP BY 1
    HAVING count(*) = 2 AND bool_and(g.ledger_scope IN ('platform', 'bridge'))
       AND sum(CASE WHEN g.direction = m.debit_when THEN g.amount ELSE -g.amount END) = 0
       AND sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) = 0) z;
  IF v_n <> 4 THEN RAISE EXCEPTION 'spiro A13 correction: post-check groups (%)', v_n; END IF;
  FOR r IN SELECT * FROM _spiro_fix LOOP
    SELECT COALESCE(sum(CASE WHEN g.category = 'equipment_expense' THEN CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END END), 0),
           COALESCE(sum(CASE WHEN g.category = 'receivable_restatement_equity' THEN CASE WHEN g.direction = 'cash_out' THEN -g.amount ELSE g.amount END END), 0)
      INTO v_x1, v_e3
    FROM public.general_ledger g
    WHERE (g.source_table = 'merchandise_sales' AND g.source_id = r.sale) OR (g.source_table = 'merchandise_recovery_plans' AND g.source_id = r.plan);
    v_net := public._merch_receivable_net(r.sale, ARRAY[r.plan], true);
    IF v_x1 <> 0 OR v_e3 <> 0
       OR (v_net->>'a13')::numeric <> 710000 - (SELECT COALESCE(principal_recovered, 0) FROM public.merchandise_recovery_plans WHERE id = r.plan)
       OR NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE id = r.plan AND principal_total = 710000 AND fee_total = 700000
                        AND original_amount = 1410000 AND status = 'active') THEN
      v_bad := v_bad || r.who || format(' X1 %s E3 %s A13 %s; ', v_x1, v_e3, v_net->>'a13');
    END IF;
  END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'spiro A13 correction: post-check failed - %', v_bad; END IF;
  IF EXISTS (SELECT 1 FROM public.general_ledger WHERE left(idempotency_key, 27) = 'spiro_release_a13_20261104:' AND ledger_scope = 'wallet') THEN
    RAISE EXCEPTION 'spiro A13 correction: wallet leg written';
  END IF;
END $post$;
