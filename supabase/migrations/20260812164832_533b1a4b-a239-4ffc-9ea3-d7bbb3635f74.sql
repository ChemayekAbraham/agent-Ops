CREATE TABLE IF NOT EXISTS public.payout_acceptance_check_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  check_key text NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('pass','fail','warn')),
  observed numeric NOT NULL DEFAULT 0,
  expected numeric NOT NULL DEFAULT 0,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.payout_acceptance_check_runs TO authenticated;
GRANT ALL ON public.payout_acceptance_check_runs TO service_role;

ALTER TABLE public.payout_acceptance_check_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance and exec roles read acceptance runs"
ON public.payout_acceptance_check_runs
FOR SELECT
TO authenticated
USING (
  public.has_role((select auth.uid()), 'cfo')
  OR public.has_role((select auth.uid()), 'financial_ops')
  OR public.has_role((select auth.uid()), 'ceo')
  OR public.has_role((select auth.uid()), 'coo')
  OR public.has_role((select auth.uid()), 'cto')
  OR public.has_role((select auth.uid()), 'manager')
  OR public.has_role((select auth.uid()), 'super_admin')
);

CREATE INDEX IF NOT EXISTS idx_payout_acceptance_runs_run
  ON public.payout_acceptance_check_runs (run_id, check_key);
CREATE INDEX IF NOT EXISTS idx_payout_acceptance_runs_created
  ON public.payout_acceptance_check_runs (created_at DESC);

CREATE OR REPLACE FUNCTION public.run_payout_acceptance_checks(
  p_window_days integer DEFAULT 7
)
RETURNS TABLE (
  check_key text,
  title text,
  status text,
  observed numeric,
  expected numeric,
  detail text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(days => greatest(1, coalesce(p_window_days, 7)));
  v_n numeric;
  v_amt numeric;
  v_txt text;
BEGIN
  -- 1. STRUCTURAL GUARD: the full (non-partial) unique index the out-of-pocket
  -- upsert infers. A partial index silently breaks ON CONFLICT, which is the
  -- exact defect that lost 14 receivables on 2026-08-12.
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

  -- 2. Customer wallet debited exactly once per merchant payout.
  SELECT count(*), coalesce(sum(t.amt), 0) INTO v_n, v_amt
  FROM (
    SELECT g.source_id, sum(g.amount) AS amt
    FROM general_ledger g
    WHERE g.source_table = 'withdrawal_requests'
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_out'
      AND g.category = 'wallet_withdrawal'
      AND g.created_at >= v_since
    GROUP BY g.source_id
    HAVING count(*) > 1
  ) t;
  RETURN QUERY SELECT
    'single_customer_debit',
    'Customer wallet debited exactly once per payout',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s payouts with duplicate wallet debits (UGX %s over-debited)', v_n, round(v_amt));

  -- 3. No duplicate commission awards.
  SELECT count(*) INTO v_n
  FROM (
    SELECT withdrawal_id FROM merchant_commission_awards
    WHERE withdrawal_id IS NOT NULL
    GROUP BY withdrawal_id HAVING count(*) > 1
  ) t;
  RETURN QUERY SELECT
    'no_duplicate_commission',
    'Commission awarded at most once per payout',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s payouts with more than one commission award', v_n);

  -- 4. No eligible merchant payout left without its commission.
  SELECT count(*) INTO v_n
  FROM withdrawal_requests w
  WHERE w.assigned_cashout_agent_id IS NOT NULL
    AND w.status IN ('paid','completed')
    AND w.processed_at >= v_since
    AND EXISTS (
      SELECT 1 FROM general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = w.id
        AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
        AND g.category = 'wallet_withdrawal'
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

  -- 5. Nothing claims to be settled while its legs are missing.
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
        AND g.category = 'wallet_withdrawal'
    );
  RETURN QUERY SELECT
    'settled_means_settled',
    'No payout marked settled without a customer wallet debit',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s payouts marked settled with no wallet debit leg', v_n);

  -- 6. Unsettled payouts stay VISIBLE (the queue must not hide them).
  SELECT count(*), coalesce(sum(amount), 0) INTO v_n, v_amt
  FROM withdrawal_requests
  WHERE assigned_cashout_agent_id IS NOT NULL
    AND status IN ('paid','completed')
    AND settlement_state IN ('unsettled','partially_settled')
    AND processed_at >= v_since;
  RETURN QUERY SELECT
    'unsettled_visible',
    'Incomplete settlements are surfaced, not hidden',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'warn' END,
    v_n, 0::numeric,
    format('%s payouts (UGX %s) in the FinOps reconciliation queue', v_n, round(v_amt));

  -- 7. Stranded claims: processing with no legs and no evidence.
  SELECT count(*), coalesce(sum(amount), 0) INTO v_n, v_amt
  FROM withdrawal_requests
  WHERE assigned_cashout_agent_id IS NOT NULL
    AND status = 'processing'
    AND NOT EXISTS (
      SELECT 1 FROM general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = withdrawal_requests.id
    );
  RETURN QUERY SELECT
    'no_stranded_claims',
    'No claim stuck in processing with zero money records',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s stranded processing payouts (UGX %s) ring-fencing float', v_n, round(v_amt));

  -- 8. Merchant float cannot be committed twice for one payout.
  SELECT count(*) INTO v_n
  FROM (
    SELECT withdrawal_id FROM merchant_float_reservations
    WHERE state <> 'released'
    GROUP BY withdrawal_id HAVING count(*) > 1
  ) t;
  RETURN QUERY SELECT
    'float_single_reservation',
    'One live float reservation per payout',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s payouts holding more than one open float reservation', v_n);

  -- 9. Reservations must not leak on terminal payouts.
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

  -- 10. SMS/TID evidence can never by itself declare settlement.
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

  -- 11. Merchant identity is resolved server-side.
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'resolve_payout_merchant_identity';
  RETURN QUERY SELECT
    'server_side_merchant_identity',
    'Merchant identity resolved server-side, not from the client',
    CASE WHEN v_n >= 1 THEN 'pass' ELSE 'fail' END,
    v_n, 1::numeric,
    CASE WHEN v_n >= 1 THEN 'resolver present' ELSE 'resolver missing: client flags could suppress merchant pay' END;

  -- 12. Fail-closed capability columns (no NULL = "assume allowed").
  SELECT count(*) INTO v_n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'cashout_agents'
    AND column_name IN ('handles_mtn','handles_airtel','handles_bank')
    AND is_nullable = 'YES';
  RETURN QUERY SELECT
    'capabilities_fail_closed',
    'Payout capabilities are fail-closed (NOT NULL)',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s capability columns still nullable (nullable = fail-open)', v_n);

  -- 13. Funding source truthfully classified (no fake float deductions).
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

  -- 14. Reconciliation automation alive.
  SELECT count(*) INTO v_n
  FROM cron.job
  WHERE active
    AND jobname IN (
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
END;
$$;

REVOKE ALL ON FUNCTION public.run_payout_acceptance_checks(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_payout_acceptance_checks(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_payout_acceptance_run(
  p_window_days integer DEFAULT 7
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.payout_acceptance_check_runs
    (run_id, check_key, title, status, observed, expected, detail)
  SELECT v_run, c.check_key, c.title, c.status, c.observed, c.expected, c.detail
  FROM public.run_payout_acceptance_checks(p_window_days) c;

  DELETE FROM public.payout_acceptance_check_runs
  WHERE created_at < now() - interval '180 days';

  RETURN v_run;
END;
$$;

REVOKE ALL ON FUNCTION public.record_payout_acceptance_run(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payout_acceptance_run(integer) TO service_role;