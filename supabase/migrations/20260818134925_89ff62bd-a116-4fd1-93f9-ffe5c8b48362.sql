-- PHASE 4: live float — stream wallet balance changes to both boards
ALTER TABLE public.wallet_balances_projection REPLICA IDENTITY FULL;

DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'wallet_balances_projection'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.wallet_balances_projection';
  END IF;
END
$pub$;

-- PHASE 7: extend the payout acceptance suite with merchant-float invariants
CREATE OR REPLACE FUNCTION public.run_payout_acceptance_checks(p_window_days integer DEFAULT 7)
 RETURNS TABLE(check_key text, title text, status text, observed numeric, expected numeric, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(days => greatest(1, coalesce(p_window_days, 7)));
  v_debit_cats text[] := ARRAY['wallet_withdrawal','agent_commission_withdrawal'];
  v_n numeric;
  v_amt numeric;
  v_txt text;
BEGIN
  SELECT count(*) INTO v_n
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = 'merchant_oop_withdrawal_kind_uniq'
    AND i.indisunique
    AND i.indpred IS NULL;
  RETURN QUERY SELECT
    'oop_conflict_target_index',
    'Out-of-pocket ON CONFLICT target is a FULL unique index',
    CASE WHEN v_n >= 1 THEN 'pass' ELSE 'fail' END,
    v_n, 1::numeric,
    CASE WHEN v_n >= 1 THEN 'full unique index present on (withdrawal_id, kind)'
         ELSE 'MISSING/partial-only: every out-of-pocket receivable write will fail' END;

  SELECT count(*), coalesce(sum(t.amt), 0) INTO v_n, v_amt
  FROM (
    SELECT g.source_id, g.category, sum(g.amount) AS amt
    FROM general_ledger g
    WHERE g.source_table = 'withdrawal_requests'
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_out'
      AND g.category = ANY(v_debit_cats)
      AND g.created_at >= v_since
    GROUP BY g.source_id, g.category
    HAVING count(*) > 1
  ) t;
  RETURN QUERY SELECT
    'single_customer_debit',
    'Customer wallet debited exactly once per payout',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s payouts with duplicate wallet debits (UGX %s over-debited)', v_n, round(v_amt));

  SELECT count(*) INTO v_n
  FROM (
    SELECT c2.withdrawal_id FROM merchant_commission_awards c2
    WHERE c2.withdrawal_id IS NOT NULL
    GROUP BY c2.withdrawal_id HAVING count(*) > 1
  ) t;
  RETURN QUERY SELECT
    'no_duplicate_commission',
    'Commission awarded at most once per payout',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s payouts with more than one commission award', v_n);

  SELECT count(*) INTO v_n
  FROM withdrawal_requests w
  WHERE w.assigned_cashout_agent_id IS NOT NULL
    AND w.status IN ('paid','completed')
    AND w.processed_at >= v_since
    AND EXISTS (
      SELECT 1 FROM general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = w.id
        AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
        AND g.category = ANY(v_debit_cats)
    )
    AND NOT EXISTS (
      SELECT 1 FROM merchant_commission_awards c WHERE c.withdrawal_id = w.id
    );
  RETURN QUERY SELECT
    'commission_not_lost',
    'Every settled merchant payout has its 0.5% commission',
    CASE WHEN v_n = 0 THEN 'pass' WHEN v_n <= 3 THEN 'warn' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s settled payouts awaiting commission (reconciler runs every 15 min)', v_n);

  SELECT count(*) INTO v_n
  FROM withdrawal_requests w
  WHERE w.assigned_cashout_agent_id IS NOT NULL
    AND w.status IN ('paid','completed')
    AND w.settlement_state = 'settled'
    AND w.processed_at >= v_since
    AND NOT EXISTS (
      SELECT 1 FROM general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = w.id
        AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
        AND g.category = ANY(v_debit_cats)
    );
  RETURN QUERY SELECT
    'settled_means_settled',
    'No payout marked settled without a customer wallet debit',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s payouts marked settled with no wallet debit leg', v_n);

  SELECT count(*), coalesce(sum(w2.amount), 0) INTO v_n, v_amt
  FROM withdrawal_requests w2
  WHERE w2.assigned_cashout_agent_id IS NOT NULL
    AND w2.status IN ('paid','completed')
    AND w2.settlement_state IN ('unsettled','partially_settled')
    AND w2.processed_at >= v_since;
  RETURN QUERY SELECT
    'unsettled_visible',
    'Incomplete settlements are surfaced, not hidden',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'warn' END,
    v_n, 0::numeric,
    format('%s payouts (UGX %s) in the FinOps reconciliation queue', v_n, round(v_amt));

  SELECT count(*), coalesce(sum(w3.amount), 0) INTO v_n, v_amt
  FROM withdrawal_requests w3
  WHERE w3.assigned_cashout_agent_id IS NOT NULL
    AND w3.status = 'processing'
    AND NOT EXISTS (
      SELECT 1 FROM general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = w3.id
    );
  RETURN QUERY SELECT
    'no_stranded_claims',
    'No claim stuck in processing with zero money records',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s stranded processing payouts (UGX %s) ring-fencing float', v_n, round(v_amt));

  SELECT count(*) INTO v_n
  FROM (
    SELECT r2.withdrawal_id FROM merchant_float_reservations r2
    WHERE r2.state <> 'released'
    GROUP BY r2.withdrawal_id HAVING count(*) > 1
  ) t;
  RETURN QUERY SELECT
    'float_single_reservation',
    'One live float reservation per payout',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s payouts holding more than one open float reservation', v_n);

  SELECT count(*) INTO v_n
  FROM merchant_float_reservations r
  JOIN withdrawal_requests w ON w.id = r.withdrawal_id
  WHERE r.state = 'reserved'
    AND w.status IN ('paid','completed','rejected','failed','cancelled');
  RETURN QUERY SELECT
    'no_leaked_reservations',
    'Float released/consumed once a payout is terminal',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s reservations still held on terminal payouts', v_n);

  SELECT pg_get_functiondef(p.oid) INTO v_txt
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'finalize_withdrawal_from_matched_payout_sms'
  LIMIT 1;
  RETURN QUERY SELECT
    'sms_is_evidence_only',
    'Payment SMS/TID match is evidence only, never settlement',
    CASE WHEN v_txt IS NULL THEN 'fail'
         WHEN v_txt LIKE '%withdrawal_settlement_status%' THEN 'pass'
         ELSE 'fail' END,
    CASE WHEN v_txt LIKE '%withdrawal_settlement_status%' THEN 1 ELSE 0 END::numeric,
    1::numeric,
    CASE WHEN v_txt IS NULL THEN 'finalizer function missing'
         WHEN v_txt LIKE '%withdrawal_settlement_status%'
           THEN 'finalizer defers to the ledger-backed settlement check'
         ELSE 'DANGER: finalizer can stamp paid without a settlement check' END;

  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'resolve_payout_merchant_identity';
  RETURN QUERY SELECT
    'server_side_merchant_identity',
    'Merchant identity resolved server-side, not from the client',
    CASE WHEN v_n >= 1 THEN 'pass' ELSE 'fail' END,
    v_n, 1::numeric,
    CASE WHEN v_n >= 1 THEN 'resolver present' ELSE 'resolver missing: client flags could suppress merchant pay' END;

  SELECT count(*) INTO v_n
  FROM information_schema.columns col
  WHERE col.table_schema = 'public' AND col.table_name = 'cashout_agents'
    AND col.column_name IN ('handles_mtn','handles_airtel','handles_bank')
    AND col.is_nullable = 'YES';
  RETURN QUERY SELECT
    'capabilities_fail_closed',
    'Payout capabilities are fail-closed (NOT NULL)',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s capability columns still nullable (nullable = fail-open)', v_n);

  SELECT count(*) INTO v_n
  FROM merchant_payout_funding f
  JOIN withdrawal_requests w ON w.id = f.withdrawal_id
  WHERE f.funding_source = 'needs_review'
    AND w.processed_at >= v_since;
  RETURN QUERY SELECT
    'funding_source_classified',
    'Funding source (float vs own cash) proven from real ledger legs',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'warn' END,
    v_n, 0::numeric,
    format('%s payouts still needing evidence before a receivable is raised', v_n);

  SELECT count(*) INTO v_n
  FROM cron.job j
  WHERE j.active
    AND j.jobname IN (
      'sweep-withdrawal-settlement-states',
      'reconcile-evidenced-withdrawal-settlements',
      'reconcile-merchant-payout-commissions',
      'detect-merchant-float-variances'
    );
  RETURN QUERY SELECT
    'reconcilers_alive',
    'Self-healing reconciliation jobs are scheduled and active',
    CASE WHEN v_n >= 4 THEN 'pass' WHEN v_n >= 2 THEN 'warn' ELSE 'fail' END,
    v_n, 4::numeric,
    format('%s of 4 reconciliation jobs active', v_n);

  -- PHASE 7 additions: merchant float must read the same on every surface
  SELECT count(*), coalesce(max(abs(t.diff)), 0) INTO v_n, v_amt
  FROM (
    SELECT ca.agent_id,
           round(public.merchant_ledger_float(ca.agent_id))
             - round(coalesce(p.float_balance, 0)) AS diff
    FROM cashout_agents ca
    LEFT JOIN wallet_balances_projection p ON p.user_id = ca.agent_id
    WHERE ca.is_active AND ca.agent_id IS NOT NULL
  ) t
  WHERE t.diff <> 0;
  RETURN QUERY SELECT
    'merchant_float_agrees',
    'Merchant desk float on the books equals the float on screen',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s active desks disagree with the ledger (largest gap UGX %s)', v_n, round(v_amt));

  SELECT count(*), coalesce(sum(-t.net), 0) INTO v_n, v_amt
  FROM (
    SELECT ca.agent_id, public.merchant_float_visible_net(ca.agent_id) AS net
    FROM cashout_agents ca
    WHERE ca.is_active AND ca.agent_id IS NOT NULL
  ) t
  WHERE t.net < 0;
  RETURN QUERY SELECT
    'merchant_float_no_hidden_deficit',
    'No merchant desk hides a negative float position',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s active desks are truly negative (UGX %s hidden by the zero floor)', v_n, round(v_amt));

  SELECT count(*) INTO v_n
  FROM pg_trigger tg
  JOIN pg_class c ON c.oid = tg.tgrelid
  JOIN pg_proc pr ON pr.oid = tg.tgfoid
  WHERE c.relname = 'merchant_float_reconciliations'
    AND NOT tg.tgisinternal
    AND pr.proname = 'guard_merchant_float_reconciliation';
  RETURN QUERY SELECT
    'merchant_correction_gate_armed',
    'Unauthorised merchant float corrections are blocked at the database',
    CASE WHEN v_n >= 1 THEN 'pass' ELSE 'fail' END,
    v_n, 1::numeric,
    CASE WHEN v_n >= 1 THEN 'role + self-authorship guard attached'
         ELSE 'GATE MISSING: any writer could correct a merchant desk' END;

  SELECT count(*) INTO v_n
  FROM pg_publication_tables pt
  WHERE pt.pubname = 'supabase_realtime'
    AND pt.schemaname = 'public'
    AND pt.tablename = 'wallet_balances_projection';
  RETURN QUERY SELECT
    'float_live_stream_on',
    'Float changes stream live to the merchant and FinOps boards',
    CASE WHEN v_n >= 1 THEN 'pass' ELSE 'fail' END,
    v_n, 1::numeric,
    CASE WHEN v_n >= 1 THEN 'wallet balance changes are published'
         ELSE 'NOT PUBLISHED: boards will drift until the next poll' END;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.run_payout_acceptance_checks(integer) TO authenticated, service_role;