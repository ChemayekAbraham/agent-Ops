-- Part 3 of 3 — Welile Homes collections must reduce the A6 receivable.
-- BIS approved. Requires 20260903100000 and 20260903100100.
--
-- ── Two corrections ─────────────────────────────────────────────────────────
--
-- 1. Collection mapping direction.
--
--    The collection mappings were registered with debit_when = 'cash_in'. The
--    platform leg of a collection is posted 'cash_in' (cash received), so that
--    combination DEBITS the receivable and would have increased it on payment.
--
--    The house convention for settlement categories on the platform scope is
--    debit_when = 'cash_out', so an incoming cash leg credits the receivable:
--
--      platform.rent_repayment    -> A3  cash_out
--      platform.tenant_repayment  -> A3  cash_out
--      platform.agent_repayment   -> A4  cash_out
--
--    Both new collection categories now follow it. No general_ledger row had
--    been posted with either category, so this corrects the mapping before it
--    was ever used and moves no balance.
--
-- 2. welile_home_record_collection posted the wrong receivable.
--
--    Its platform leg used category 'rent_repayment', which maps to A3 Rent
--    Access Receivables — the tenant rent receivable. A3 does not hold the
--    Welile Homes balance, so collections reduced an unrelated account while
--    A6 would have grown indefinitely.
--
--    Only the two platform legs change category. The wallet legs, the agent
--    allocation branch, the 2% agent commission legs, the FIFO dues
--    application and the create_ledger_transaction call are all untouched.
--
--    The rewrite is a guarded text replacement against the live definition
--    rather than a restatement of the whole function, so no unrelated line can
--    drift. It aborts if either expected leg is missing, or if any platform
--    rent_repayment leg survives.

UPDATE public.ledger_account_map
   SET debit_when = 'cash_out'
 WHERE ledger_scope = 'platform'
   AND category IN ('partner_receivable_collected','landlord_receivable_collected')
   AND debit_when <> 'cash_out';

DO $do$
DECLARE
  v_def text;
  v_new text;
  v_old_1 text := '''category'',''rent_repayment'',''ledger_scope'',''platform'',''classification'',''production'',''description'',''Welile Homes rent received''';
  v_new_1 text := '''category'',''landlord_receivable_collected'',''ledger_scope'',''platform'',''classification'',''production'',''description'',''Welile Homes rent received''';
  v_old_2 text := '''category'',''rent_repayment'',''ledger_scope'',''platform'',''classification'',''production'',''description'',''Welile Homes rent received (agent-allocated)''';
  v_new_2 text := '''category'',''landlord_receivable_collected'',''ledger_scope'',''platform'',''classification'',''production'',''description'',''Welile Homes rent received (agent-allocated)''';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'welile_home_record_collection';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'welile_home_record_collection not found';
  END IF;

  -- Already applied: nothing to do.
  IF position(v_old_1 in v_def) = 0 AND position(v_old_2 in v_def) = 0
     AND position('landlord_receivable_collected' in v_def) > 0 THEN
    RAISE NOTICE 'welile_home_record_collection already updated — skipping';
    RETURN;
  END IF;

  IF position(v_old_1 in v_def) = 0 OR position(v_old_2 in v_def) = 0 THEN
    RAISE EXCEPTION 'Expected platform legs not found — aborting rather than guessing';
  END IF;

  v_new := replace(replace(v_def, v_old_1, v_new_1), v_old_2, v_new_2);

  IF position('''category'',''rent_repayment'',''ledger_scope'',''platform''' in v_new) > 0 THEN
    RAISE EXCEPTION 'A platform rent_repayment leg still remains — aborting';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'welile_home_record_collection updated';
END
$do$;

-- ── Verification ────────────────────────────────────────────────────────────
--
--   SELECT ledger_scope, category, account_code, debit_when
--     FROM ledger_account_map
--    WHERE category IN ('partner_receivable_collected','landlord_receivable_collected');
--   -- both expect A6/A7 with debit_when 'cash_out'
--
--   SELECT (pg_get_functiondef(p.oid) LIKE '%landlord_receivable_collected%') AS uses_new,
--          (pg_get_functiondef(p.oid) LIKE '%''category'',''rent_repayment'',''ledger_scope'',''platform''%') AS stale
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname='welile_home_record_collection';
--   -- expect uses_new = true, stale = false
--
-- After the next Welile Homes collection, A6 should fall by the collected
-- amount and welile_homes_subscriptions.outstanding_balance should fall by the
-- same amount, keeping the ledger and the sub-ledger reconciled:
--
--   SELECT (SELECT ROUND(SUM(CASE WHEN direction='cash_in' THEN -amount ELSE amount END))
--             FROM general_ledger
--            WHERE category IN ('landlord_receivable_created','landlord_receivable_collected'))
--          AS a6_net,
--          (SELECT ROUND(SUM(COALESCE(outstanding_balance,0)))
--             FROM welile_homes_subscriptions WHERE subscription_status='active')
--          AS sub_ledger;
