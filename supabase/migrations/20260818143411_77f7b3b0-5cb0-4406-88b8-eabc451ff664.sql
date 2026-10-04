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

  -- ===================================================================
  -- PHASE 7 (P4) STRUCTURAL INVARIANTS
  -- ===================================================================

  -- (i) No reporting RPC may emit the same expression under two output names.
  SELECT count(*) INTO v_n FROM (
    SELECT p.proname, lower(regexp_replace(m[1], '\s+', '', 'g')) AS expr
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
    LATERAL regexp_matches(
      p.prosrc,
      '[,(]\s*((?:[a-zA-Z0-9_]+\s*\([^()]*\)|[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+))\s+AS\s+([a-zA-Z0-9_]+)',
      'gi') AS m
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proname LIKE 'get%'
      AND p.proname <> 'run_payout_acceptance_checks'
      AND m[1] ~* '(amount|balance|float|net|total)'
    GROUP BY p.proname, 2
    HAVING count(DISTINCT lower(m[2])) > 1
  ) t;
  RETURN QUERY SELECT
    'no_aliased_duplicate_money_column',
    'No report shows the same money figure under two different names',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s reporting function(s) emit one money expression under two output columns', v_n);

  -- (ii) A reconciliation (narrative) row and a ledger leg may never both feed one total.
  SELECT count(*) INTO v_n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND p.proname <> 'run_payout_acceptance_checks'
    AND p.prosrc ~* '(ledger_float|merchant_ledger_float\([^)]*\))\s*[+-]\s*[a-z_]*\.?(adjust|recon|display_only)';
  RETURN QUERY SELECT
    'no_double_counted_correction',
    'Narrative corrections are never added on top of the ledger truth',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s function(s) add reconciliation adjustments onto a ledger-derived balance', v_n);

  -- (iii) Every correcting insert path enforces a role check AND a self-authorship block.
  SELECT count(*) INTO v_n
  FROM (VALUES
    ('merchant_float_reconciliations'),
    ('platform_wallet_corrections'),
    ('agent_landlord_float_corrections')
  ) tbls(tbl)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_proc pr ON pr.oid = tg.tgfoid
    WHERE c.relname = tbls.tbl
      AND NOT tg.tgisinternal
      AND (tg.tgtype & 4) > 0
      AND (tg.tgtype & 8) > 0
      AND pr.prosrc ILIKE '%has_role%'
      AND pr.prosrc ILIKE '%auth.uid()%'
  );
  RETURN QUERY SELECT
    'correction_paths_gated',
    'Every correcting write is role-checked and cannot be self-authorised',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s correction table(s) accept writes without a role + self-authorship guard', v_n);

  -- (iv) Every ledger transaction group nets to zero.
  SELECT count(*), coalesce(sum(abs(t.net)), 0) INTO v_n, v_amt
  FROM (
    SELECT g.transaction_group_id,
           sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) AS net
    FROM general_ledger g
    WHERE g.created_at >= v_since
      AND g.transaction_group_id IS NOT NULL
    GROUP BY g.transaction_group_id
    HAVING count(*) > 1
  ) t
  WHERE round(t.net, 2) <> 0;
  RETURN QUERY SELECT
    'ledger_groups_net_zero',
    'Every money movement balances: what goes in equals what goes out',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s ledger group(s) in the window are unbalanced (UGX %s out of balance)', v_n, round(v_amt));

END;
$function$;

-- ============================================================
-- P4 (iii): guard the remaining correcting insert path
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_agent_landlord_float_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    IF NEW.performed_by_process IS NULL OR length(btrim(NEW.performed_by_process)) = 0 THEN
      RAISE EXCEPTION 'FLOAT_CORRECTION_PROCESS_REQUIRED: a system correction must name the process that made it'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'FLOAT_CORRECTION_AUTHOR_MISMATCH: the correction must be recorded under the signed-in author'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
    public.has_role(NEW.performed_by, 'cfo')
    OR public.has_role(NEW.performed_by, 'financial_ops')
    OR public.has_role(NEW.performed_by, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'FLOAT_CORRECTION_NOT_AUTHORIZED: only the CFO, Financial Ops or a super admin can correct agent float'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.performed_by = NEW.agent_id THEN
    RAISE EXCEPTION 'FLOAT_CORRECTION_SELF_BLOCKED: you cannot correct your own float'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.reason IS NULL OR length(btrim(NEW.reason)) < 20 THEN
    RAISE EXCEPTION 'FLOAT_CORRECTION_EVIDENCE_REQUIRED: written evidence of at least 20 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_guard_agent_landlord_float_correction ON public.agent_landlord_float_corrections;
CREATE TRIGGER trg_guard_agent_landlord_float_correction
BEFORE INSERT ON public.agent_landlord_float_corrections
FOR EACH ROW EXECUTE FUNCTION public.guard_agent_landlord_float_correction();

-- ============================================================
-- PHASE 7 (2): scheduled acceptance scan -> finance anomaly alert path
-- ============================================================
CREATE OR REPLACE FUNCTION public.run_payout_acceptance_scan(
  p_trigger_source text DEFAULT 'manual',
  p_window_days integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rows jsonb;
  v_fail integer := 0;
  v_warn integer := 0;
  v_total integer := 0;
  v_enabled boolean := true;
BEGIN
  SELECT COALESCE(enabled, true) INTO v_enabled
  FROM public.finance_anomaly_alert_config WHERE id = 1;

  CREATE TEMP TABLE IF NOT EXISTS _acc_tmp (
    check_key text, title text, status text,
    observed numeric, expected numeric, detail text
  ) ON COMMIT DROP;
  DELETE FROM _acc_tmp;
  INSERT INTO _acc_tmp
  SELECT * FROM public.run_payout_acceptance_checks(p_window_days);

  SELECT count(*),
         count(*) FILTER (WHERE status = 'fail'),
         count(*) FILTER (WHERE status = 'warn')
  INTO v_total, v_fail, v_warn FROM _acc_tmp;

  INSERT INTO public.finance_anomaly_alert_states AS s (
    check_key, label, category, channel, severity,
    item_count, exposure, fingerprint, state,
    first_seen_at, last_seen_at, last_changed_at, resolved_at
  )
  SELECT
    'acceptance:' || c.check_key,
    c.title,
    CASE WHEN c.status = 'fail' THEN 'financial_integrity' ELSE 'monitoring' END,
    CASE WHEN c.status = 'fail' THEN 'email' ELSE 'dashboard' END,
    CASE WHEN c.status = 'fail' THEN 'high'
         WHEN c.status = 'warn' THEN 'medium' ELSE 'clean' END,
    CASE WHEN c.status = 'pass' THEN 0 ELSE GREATEST(1, COALESCE(c.observed, 0))::integer END,
    0,
    md5(format('%s|%s|%s', c.check_key, c.status, COALESCE(c.observed, 0))),
    CASE WHEN c.status = 'pass' THEN 'RESOLVED' ELSE 'NEW' END,
    now(), now(), now(),
    CASE WHEN c.status = 'pass' THEN now() ELSE NULL END
  FROM _acc_tmp c
  ON CONFLICT (check_key) DO UPDATE SET
    label = EXCLUDED.label,
    category = EXCLUDED.category,
    channel = EXCLUDED.channel,
    severity = EXCLUDED.severity,
    item_count = EXCLUDED.item_count,
    last_seen_at = now(),
    last_changed_at = CASE WHEN s.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
                           THEN now() ELSE s.last_changed_at END,
    resolved_at = CASE WHEN EXCLUDED.item_count = 0 THEN COALESCE(s.resolved_at, now()) ELSE NULL END,
    acknowledged_at = CASE WHEN s.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
                           THEN NULL ELSE s.acknowledged_at END,
    acknowledged_by = CASE WHEN s.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
                           THEN NULL ELSE s.acknowledged_by END,
    state = CASE
      WHEN EXCLUDED.item_count = 0 THEN 'RESOLVED'
      WHEN s.state = 'RESOLVED' THEN 'NEW'
      WHEN s.acknowledged_at IS NOT NULL AND s.fingerprint = EXCLUDED.fingerprint THEN 'ACKNOWLEDGED'
      ELSE 'ACTIVE'
    END,
    fingerprint = EXCLUDED.fingerprint,
    first_seen_at = CASE WHEN s.state = 'RESOLVED' AND EXCLUDED.item_count > 0
                         THEN now() ELSE s.first_seen_at END;

  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY
           CASE c.status WHEN 'fail' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, c.check_key), '[]'::jsonb)
  INTO v_rows FROM _acc_tmp c;

  IF v_fail > 0 THEN
    INSERT INTO public.system_events (event_type, description, metadata)
    VALUES (
      'report_generation_failed',
      format('Payout acceptance checks: %s failing invariant(s)', v_fail),
      jsonb_build_object('trigger_source', p_trigger_source, 'failing', v_fail, 'warnings', v_warn)
    );
  END IF;

  RETURN jsonb_build_object(
    'scanned_at', now(),
    'trigger_source', p_trigger_source,
    'window_days', p_window_days,
    'total_checks', v_total,
    'failing', v_fail,
    'warnings', v_warn,
    'alerts_enabled', COALESCE(v_enabled, true),
    'notify_channel', CASE WHEN v_fail > 0 THEN 'email' ELSE 'none' END,
    'checks', v_rows
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.run_payout_acceptance_scan(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_payout_acceptance_scan(text, integer) TO service_role;