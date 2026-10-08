CREATE OR REPLACE FUNCTION public._cfo_bucket_a_evaluate()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mism jsonb; v_status jsonb; v_count int; v_total numeric; v_hash text;
  v_dupes int; v_excl int; v_6932 numeric; v_badacct int; v_a11n int; v_a11sum numeric;
  v_checks jsonb; v_pass boolean; v_acct_now numeric;
BEGIN
  WITH l AS (
    SELECT p.*, _cfo_bucket_a_live_balance(p.source_id, p.account) AS live,
      CASE p.source_table
        WHEN 'agent_advances' THEN (SELECT status FROM agent_advances WHERE id=p.source_id)
        WHEN 'credit_access_draws' THEN (SELECT status FROM credit_access_draws WHERE id=p.source_id)
        WHEN 'merchandise_recovery_plans' THEN (SELECT status FROM merchandise_recovery_plans WHERE id=p.source_id)
      END AS live_status
    FROM cfo_bucket_a_package_lines p
  ), e AS (
    SELECT l.*, round(l.live - l.expected_after, 2) AS live_correction,
      (live_status IS NOT NULL AND (live_status = split_part(approved_status,'/',1)
        OR (live_status IN ('active','overdue') AND split_part(approved_status,'/',1) IN ('active','overdue')))) AS status_ok
    FROM l
  )
  SELECT count(*), sum(approved_amount),
    md5(string_agg(idempotency_key||'|'||approved_amount::text||'|'||expected_after::text, ';' ORDER BY line_no)),
    COALESCE(jsonb_agg(jsonb_build_object('line_no',line_no,'source_id',source_id,'account',account,'reason',reason,
       'approved_amount',approved_amount,'current_amount',live_correction,'difference',live_correction-approved_amount,
       'mismatch_reason','Live books balance differs from the approved correction')) FILTER (WHERE abs(live_correction-approved_amount) > 0.005),'[]'),
    COALESCE(jsonb_agg(jsonb_build_object('line_no',line_no,'source_id',source_id,'account',account,
       'approved_status',approved_status,'current_status',COALESCE(live_status,'missing'))) FILTER (WHERE NOT status_ok),'[]'),
    count(*) FILTER (WHERE reason = 'Duplicate access fee (A11)'),
    sum(approved_amount) FILTER (WHERE reason = 'Duplicate access fee (A11)')
  INTO v_count, v_total, v_hash, v_mism, v_status, v_a11n, v_a11sum
  FROM e;

  SELECT count(*) INTO v_dupes FROM general_ledger
   WHERE idempotency_key LIKE 'CFOGATE-2026-10:%' OR description LIKE '%CFOGATE-2026-10%';
  SELECT count(*) INTO v_excl FROM cfo_bucket_a_package_lines
   WHERE source_id IN ('9ef03c86-ec7a-4730-b32c-d86092feb81a','7612edc4-0e2e-48f0-9510-e0ffc427d4da',
                       'b94abec1-37b7-4eb0-8af5-200373aa140b','cef95679-bd3b-4b4a-88a0-bae32e39a1c5',
                       'c75a2acc-6dcf-47ba-bce3-2213bfb40ad1');
  SELECT COALESCE(sum(amount),0) INTO v_6932 FROM general_ledger
   WHERE source_id='c75a2acc-6dcf-47ba-bce3-2213bfb40ad1' AND ledger_scope='platform' AND category='agent_advance_repayment' AND direction='cash_in';
  SELECT count(*) INTO v_badacct FROM cfo_bucket_a_package_lines
   WHERE account NOT IN ('A10','A11','A12','A14') OR receivable_category NOT LIKE '%receivable_opening';

  v_checks := jsonb_build_array(
    jsonb_build_object('check','Record count is 322','pass', v_count = 322, 'value', v_count),
    jsonb_build_object('check','Total is UGX 10,133,013.74','pass', v_total = 10133013.74, 'value', v_total),
    jsonb_build_object('check','Package fingerprint matches the CFO-approved package','pass', v_hash = '06c325a8a903136ac86d63886ecc90a6', 'value', v_hash),
    jsonb_build_object('check','Debits equal credits (each correction is one receivable credit and one equal equity debit)','pass', NULL, 'status','DEBITS/CREDITS: VERIFIED AT POSTING', 'value', v_total),
    jsonb_build_object('check','Every record matches its approved amount individually','pass', jsonb_array_length(v_mism)=0, 'value', jsonb_array_length(v_mism)),
    jsonb_build_object('check','No source record status changed','pass', jsonb_array_length(v_status)=0, 'value', jsonb_array_length(v_status)),
    jsonb_build_object('check','No matching correction already in the ledger','pass', v_dupes=0, 'value', v_dupes),
    jsonb_build_object('check','Duplicate access fee still UGX 9,551,168 across 314 advances','pass', v_a11n=314 AND v_a11sum=9551168, 'value', v_a11sum),
    jsonb_build_object('check','Yaseen Kc, Sharifu Kalule, Bucket B/C and the UGX 6,932 item are not in the package','pass', v_excl=0, 'value', v_excl),
    jsonb_build_object('check','UGX 6,932 item unchanged and outside Bucket A','pass', v_6932=6932, 'value', v_6932),
    jsonb_build_object('check','Only receivable and restatement equity accounts touched (no cash, wallet, float, repayment)','pass', v_badacct=0, 'value', v_badacct),
    jsonb_build_object('check','Old restatement routine not used','pass', NULL, 'status','OLD RESTATEMENT ROUTINE: NOT USED BY POSTING PATH', 'value', 'separate posting function')
  );
  SELECT bool_and((c->>'pass')::boolean) INTO v_pass FROM jsonb_array_elements(v_checks) c;

  SELECT COALESCE(sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END),0) INTO v_acct_now
    FROM general_ledger gl
    JOIN ledger_account_map m ON m.ledger_scope=gl.ledger_scope AND m.category=gl.category AND m.wallet_bucket IS NULL
   WHERE m.account_code IN ('A10','A11','A12','A14') AND gl.classification IN ('production','legacy_real');

  RETURN jsonb_build_object('pass', v_pass, 'package_hash', v_hash, 'record_count', v_count, 'total', v_total,
    'checks', v_checks, 'amount_mismatches', v_mism, 'status_changes', v_status,
    'existing_corrections', v_dupes, 'mapped_receivable_balance_now', v_acct_now, 'evaluated_at', now());
END $function$;

CREATE OR REPLACE FUNCTION public.cfo_bucket_a_post(p_preflight_id uuid, p_package_hash text, p_confirmation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pf cfo_bucket_a_events; v jsonb; r record; v_gid uuid; v_groups jsonb := '[]'; v_after jsonb;
  v_dr numeric; v_cr numeric; v_bad int; v_leg_count int; v_left int; v_err text; v_ev uuid; v_att_n int := 0; v_att_total numeric := 0;
BEGIN
  IF NOT public.is_bucket_a_approver(auth.uid()) THEN
    RAISE EXCEPTION 'Only an authorised CFO approver can post Bucket A';
  END IF;
  IF p_confirmation IS DISTINCT FROM 'AUTHORIZE BUCKET A POSTING' THEN
    RAISE EXCEPTION 'Type AUTHORIZE BUCKET A POSTING exactly to authorise';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cfo_bucket_a_post'));
  IF EXISTS (SELECT 1 FROM cfo_bucket_a_events WHERE event_type='posting_committed') THEN
    RAISE EXCEPTION 'Bucket A has already been posted';
  END IF;
  SELECT * INTO v_pf FROM cfo_bucket_a_events WHERE id = p_preflight_id;
  IF v_pf.id IS NULL OR v_pf.event_type <> 'preflight_passed' OR v_pf.actor <> auth.uid()
     OR v_pf.created_at < now() - interval '30 minutes'
     OR v_pf.id <> (SELECT id FROM cfo_bucket_a_events WHERE event_type LIKE 'preflight%' ORDER BY created_at DESC LIMIT 1) THEN
    RAISE EXCEPTION 'Run a fresh pre-flight (your own, passed, latest, under 30 minutes old) before authorising';
  END IF;

  v := public._cfo_bucket_a_evaluate();
  IF NOT (v->>'pass')::boolean OR v->>'package_hash' <> p_package_hash OR v_pf.package_hash <> p_package_hash THEN
    INSERT INTO cfo_bucket_a_events(event_type, actor, package_hash, preflight_id, record_count, total_amount, details)
    VALUES ('posting_blocked', auth.uid(), v->>'package_hash', p_preflight_id, NULL, NULL,
            v || jsonb_build_object('posting_attempted', false, 'final_result', 'NO POSTING ATTEMPTED',
              'failure_reason', 'Final live re-check failed or fingerprint differed',
              'approved_package_record_count', 322, 'approved_package_total', 10133013.74,
              'evaluated_record_count', (v->>'record_count')::int, 'evaluated_total', (v->>'total')::numeric));
    RETURN jsonb_build_object('status','blocked','message','POSTING BLOCKED - APPROVED RECORD SET HAS CHANGED','evaluation',v);
  END IF;

  BEGIN  -- savepoint: any failure undoes every posted line
    FOR r IN SELECT * FROM cfo_bucket_a_package_lines ORDER BY line_no LOOP
      IF EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = r.idempotency_key) THEN
        RAISE EXCEPTION 'Idempotency key already exists: %', r.idempotency_key;
      END IF;
      v_gid := public.create_ledger_transaction(jsonb_build_array(
        jsonb_build_object('amount', r.approved_amount, 'direction','cash_out', 'category', r.receivable_category,
          'ledger_scope','bridge','classification','production','source_table', r.source_table,'source_id', r.source_id,
          'description','CFOGATE-2026-10 Bucket A correction ('||r.account||'): '||r.reason||' for '||r.source_table||' '||r.source_id
            ||'. Clears the stale receivable to '||to_char(r.expected_after,'FM999999999990.00')||'. CFO authorised.'),
        jsonb_build_object('amount', r.approved_amount, 'direction','cash_in', 'category','receivable_restatement_equity',
          'ledger_scope','platform','classification','production','source_table', r.source_table,'source_id', r.source_id,
          'description','CFOGATE-2026-10 Bucket A correction equity counterpart ('||r.account||') for '||r.source_table||' '||r.source_id)
        ), r.idempotency_key, false);
      v_groups := v_groups || jsonb_build_object('line_no', r.line_no, 'idempotency_key', r.idempotency_key, 'group_id', v_gid);
      v_att_n := v_att_n + 1; v_att_total := v_att_total + r.approved_amount;
    END LOOP;

    SELECT count(*), sum(amount) FILTER (WHERE direction='cash_in'), sum(amount) FILTER (WHERE direction='cash_out'),
           count(*) FILTER (WHERE ledger_scope NOT IN ('bridge','platform') OR wallet_id IS NOT NULL OR user_id IS NOT NULL
                            OR category NOT IN ('agent_advance_receivable_opening','agent_access_fee_receivable_opening',
                                                'merchandise_recovery_receivable_opening','credit_draw_receivable_opening',
                                                'receivable_restatement_equity'))
      INTO v_leg_count, v_dr, v_cr, v_bad
      FROM general_ledger WHERE idempotency_key LIKE 'CFOGATE-2026-10:%';
    IF v_leg_count <> 644 OR v_dr <> 10133013.74 OR v_cr <> 10133013.74 OR v_bad <> 0 THEN
      RAISE EXCEPTION 'Post-check failed: legs %, debits %, credits %, out-of-scope legs %', v_leg_count, v_dr, v_cr, v_bad;
    END IF;
    SELECT count(*) INTO v_left FROM cfo_bucket_a_package_lines p
     WHERE abs(public._cfo_bucket_a_live_balance(p.source_id, p.account) - p.expected_after) > 0.005;
    IF v_left <> 0 THEN
      RAISE EXCEPTION 'Post-check failed: % records did not land on their expected balance', v_left;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    INSERT INTO cfo_bucket_a_events(event_type, actor, package_hash, preflight_id, record_count, total_amount, details)
    VALUES ('posting_failed', auth.uid(), p_package_hash, p_preflight_id, v_att_n, v_att_total,
            jsonb_build_object('error', v_err, 'failure_reason', v_err, 'rolled_back', true, 'final_result', 'failed / rolled back',
              'approved_package_record_count', 322, 'approved_package_total', 10133013.74,
              'attempted_record_count', v_att_n, 'attempted_total', v_att_total,
              'records_committed', 0, 'pre_evaluation', v));
    RETURN jsonb_build_object('status','rolled_back','message','Posting failed and was fully rolled back: '||v_err);
  END;

  v_after := public._cfo_bucket_a_evaluate();
  INSERT INTO cfo_bucket_a_events(event_type, actor, package_hash, preflight_id, record_count, total_amount, details)
  VALUES ('posting_committed', auth.uid(), p_package_hash, p_preflight_id, 322, 10133013.74,
    jsonb_build_object('authorized_by', auth.uid(), 'authorized_at', now(), 'journal_groups', v_groups,
      'legs', v_leg_count, 'debits', v_dr, 'credits', v_cr, 'wallet_legs', 0,
      'receivable_balance_before', v->'mapped_receivable_balance_now',
      'receivable_balance_after', v_after->'mapped_receivable_balance_now',
      'pre_evaluation', v))
  RETURNING id INTO v_ev;
  RETURN jsonb_build_object('status','committed','event_id', v_ev, 'records', 322, 'amount', 10133013.74,
    'debits', v_dr, 'credits', v_cr, 'legs', v_leg_count,
    'receivable_balance_before', v->'mapped_receivable_balance_now',
    'receivable_balance_after', v_after->'mapped_receivable_balance_now');
END $function$;