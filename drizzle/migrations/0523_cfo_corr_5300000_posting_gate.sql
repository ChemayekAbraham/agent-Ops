-- CFO correction package CORR-2026-10-08-9fc656402a73 (UGX 5,300,000, 2 lines): frozen package + live pre-flight
-- + allowlisted-CFO atomic posting gate. This migration posts NOTHING to the ledger.
CREATE TABLE public.cfo_corr_5300000_lines (
  line_no int PRIMARY KEY CHECK (line_no IN (1,2)),
  idempotency_key text NOT NULL UNIQUE,
  label text NOT NULL,
  debit_account text NOT NULL,
  credit_account text NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  source_groups text[] NOT NULL,
  post_source_table text NOT NULL,
  post_source_id uuid NOT NULL,
  receivable_leg_category text NOT NULL,
  receivable_leg_direction text NOT NULL,
  equity_leg_direction text NOT NULL
);
GRANT SELECT ON public.cfo_corr_5300000_lines TO authenticated;
GRANT ALL ON public.cfo_corr_5300000_lines TO service_role;
ALTER TABLE public.cfo_corr_5300000_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO approvers read correction package" ON public.cfo_corr_5300000_lines
  FOR SELECT TO authenticated USING (public.is_bucket_a_approver(auth.uid()) OR public.has_role(auth.uid(),'cfo'::app_role));

CREATE TABLE public.cfo_corr_5300000_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('preflight_passed','preflight_blocked','posting_committed','posting_failed','posting_blocked')),
  actor uuid,
  package_hash text,
  preflight_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.cfo_corr_5300000_events TO authenticated;
GRANT ALL ON public.cfo_corr_5300000_events TO service_role;
ALTER TABLE public.cfo_corr_5300000_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO approvers read correction events" ON public.cfo_corr_5300000_events
  FOR SELECT TO authenticated USING (public.is_bucket_a_approver(auth.uid()) OR public.has_role(auth.uid(),'cfo'::app_role));
CREATE OR REPLACE FUNCTION public.cfo_corr_5300000_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'cfo_corr_5300000_events is append-only'; END $$;
CREATE TRIGGER trg_cfo_corr_5300000_events_append_only BEFORE UPDATE OR DELETE ON public.cfo_corr_5300000_events
  FOR EACH ROW EXECUTE FUNCTION public.cfo_corr_5300000_append_only();

INSERT INTO public.cfo_corr_5300000_lines VALUES
 (1,'cfo-corr-5300000:C1:fbfa846f','C1 Yaseen Kc','E3','A10',5100000,
  ARRAY['aabf5fbe','1a4f4b8d','4a195b73','6caed92e','3332d907','fbfa846f'],
  'agent_advance_requests','9f6e8edd-29ea-42fa-9662-09583449542e','agent_advance_receivable_opening','cash_out','cash_in'),
 (2,'cfo-corr-5300000:C2:cecd73db','C2 Nabwire Jackline','A3','E3',200000,
  ARRAY['fbb5fc24','cecd73db','08ce3007'],
  'rent_requests','2a1d52d4-8d4b-48f6-a2fa-34643ba7b6f4','rent_plan_receivable_restatement','cash_in','cash_out');

-- Same canonical form the package fingerprint was computed from (sorted keys, compact JSON).
CREATE OR REPLACE FUNCTION public._cfo_corr_5300000_hash()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT md5('[' || string_agg(format('{"amount":%s,"credit":"%s","debit":"%s","key":"%s","line":%s,"source":[%s]}',
      trunc(amount)::bigint, credit_account, debit_account, idempotency_key, line_no,
      (SELECT string_agg('"'||s||'"', ',' ORDER BY o) FROM unnest(source_groups) WITH ORDINALITY u(s,o))), ',' ORDER BY line_no) || ']')
  FROM cfo_corr_5300000_lines
$$;
REVOKE ALL ON FUNCTION public._cfo_corr_5300000_hash() FROM PUBLIC, anon, authenticated;

DO $$ BEGIN
  IF public._cfo_corr_5300000_hash() <> '262bf75c20610b3682ce31a4ff508006' THEN
    RAISE EXCEPTION 'Correction package fingerprint mismatch: %', public._cfo_corr_5300000_hash();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.cfo_corr_5300000_frozen() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Correction package CORR-2026-10-08-9fc656402a73 is frozen'; END $$;
CREATE TRIGGER trg_cfo_corr_5300000_frozen BEFORE INSERT OR UPDATE OR DELETE ON public.cfo_corr_5300000_lines
  FOR EACH ROW EXECUTE FUNCTION public.cfo_corr_5300000_frozen();

-- Mapped Balance Sheet balance of one account (debit-positive).
CREATE OR REPLACE FUNCTION public._cfo_corr_5300000_acct(p_account text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END),0)
  FROM general_ledger gl
  JOIN ledger_account_map m ON m.ledger_scope=gl.ledger_scope AND m.category=gl.category AND m.wallet_bucket IS NULL
  WHERE m.account_code = p_account AND gl.classification IN ('production','legacy_real')
$$;
REVOKE ALL ON FUNCTION public._cfo_corr_5300000_acct(text) FROM PUBLIC, anon, authenticated;

-- Group leg check: count, total, and leg signature of one source transaction group.
CREATE OR REPLACE FUNCTION public._cfo_corr_5300000_group_ok(p_prefix text, p_scope text, p_cat text, p_dir text, p_amt numeric)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) = 2 AND count(*) FILTER (WHERE ledger_scope=p_scope AND category=p_cat AND direction=p_dir AND amount=p_amt) = 1
         AND count(DISTINCT amount) = 1
  FROM general_ledger WHERE transaction_group_id::text LIKE p_prefix || '-%'
$$;
REVOKE ALL ON FUNCTION public._cfo_corr_5300000_group_ok(text,text,text,text,numeric) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._cfo_corr_5300000_evaluate()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_hash text; v_n int; v_t numeric; v_dupes int; v_later int; v_overlap int; v_bad int; v_checks jsonb; v_pass boolean;
BEGIN
  v_hash := public._cfo_corr_5300000_hash();
  SELECT count(*), sum(amount) INTO v_n, v_t FROM cfo_corr_5300000_lines;
  SELECT count(*) INTO v_dupes FROM general_ledger
   WHERE idempotency_key LIKE 'cfo-corr-5300000:%' OR description LIKE '%CORR-2026-10-08-9fc656402a73%';
  SELECT count(*) INTO v_later FROM general_ledger
   WHERE source_id IN ('9f6e8edd-29ea-42fa-9662-09583449542e','2a1d52d4-8d4b-48f6-a2fa-34643ba7b6f4')
     AND transaction_date > '2026-10-01 12:33:00+00' AND COALESCE(idempotency_key,'') NOT LIKE 'cfo-corr-5300000:%';
  SELECT count(*) INTO v_overlap FROM cfo_bucket_a_package_lines
   WHERE source_id IN ('9f6e8edd-29ea-42fa-9662-09583449542e','2a1d52d4-8d4b-48f6-a2fa-34643ba7b6f4',
                       'cd32a87d-d299-4ee8-94d4-766604114ae8','2bf6d6fb-63ff-4b7b-aefc-9289a7d60f7b',
                       'e00a2bf2-2d16-426d-8de0-564177d66425','f346def6-8ae8-437d-829f-a0de0cd95379');
  SELECT count(*) INTO v_bad FROM cfo_corr_5300000_lines
   WHERE NOT ((line_no=1 AND debit_account='E3' AND credit_account='A10' AND amount=5100000)
           OR (line_no=2 AND debit_account='A3' AND credit_account='E3' AND amount=200000));

  v_checks := jsonb_build_array(
    jsonb_build_object('check','Exactly 2 lines, total UGX 5,300,000','pass', v_n=2 AND v_t=5300000, 'value', v_t),
    jsonb_build_object('check','Package fingerprint matches 262bf75c20610b3682ce31a4ff508006','pass', v_hash='262bf75c20610b3682ce31a4ff508006', 'value', v_hash),
    jsonb_build_object('check','Accounts and amounts match the approved package (C1 Dr E3/Cr A10 5,100,000; C2 Dr A3/Cr E3 200,000)','pass', v_bad=0, 'value', v_bad),
    jsonb_build_object('check','Yaseen 21 Sep top-ups unchanged (aabf5fbe, 1a4f4b8d, 4a195b73, 6caed92e = 5,100,000)','pass',
       _cfo_corr_5300000_group_ok('aabf5fbe','platform','rent_disbursement','cash_out',1500000)
       AND _cfo_corr_5300000_group_ok('1a4f4b8d','platform','rent_disbursement','cash_out',1500000)
       AND _cfo_corr_5300000_group_ok('4a195b73','platform','rent_disbursement','cash_out',100000)
       AND _cfo_corr_5300000_group_ok('6caed92e','platform','rent_disbursement','cash_out',2000000), 'value', 5100000),
    jsonb_build_object('check','25 Sep replacement 3332d907 unchanged (5,100,000)','pass', _cfo_corr_5300000_group_ok('3332d907','platform','rent_disbursement','cash_out',5100000), 'value', 5100000),
    jsonb_build_object('check','25 Sep recovery fbfa846f still booked to equity (5,100,000)','pass', _cfo_corr_5300000_group_ok('fbfa846f','platform','balance_correction','cash_in',5100000), 'value', 5100000),
    jsonb_build_object('check','Nabwire 11 Jun funding fbb5fc24 unchanged (200,000)','pass', _cfo_corr_5300000_group_ok('fbb5fc24','bridge','rent_receivable_created','cash_in',200000), 'value', 200000),
    jsonb_build_object('check','Nabwire 22 Sep removal cecd73db still in place (200,000)','pass', _cfo_corr_5300000_group_ok('cecd73db','bridge','rent_plan_receivable_restatement','cash_out',200000), 'value', 200000),
    jsonb_build_object('check','Nabwire valid 1 Oct return 08ce3007 unchanged (200,000)','pass', _cfo_corr_5300000_group_ok('08ce3007','bridge','rent_receivable_created','cash_out',200000), 'value', 200000),
    jsonb_build_object('check','Neither correction already posted','pass', v_dupes=0 AND NOT EXISTS (SELECT 1 FROM cfo_corr_5300000_events WHERE event_type='posting_committed'), 'value', v_dupes),
    jsonb_build_object('check','No later entries on the two source records','pass', v_later=0, 'value', v_later),
    jsonb_build_object('check','No overlap with the Bucket A package','pass', v_overlap=0, 'value', v_overlap)
  );
  SELECT bool_and((c->>'pass')::boolean) INTO v_pass FROM jsonb_array_elements(v_checks) c;
  RETURN jsonb_build_object('pass', v_pass, 'package_id','CORR-2026-10-08-9fc656402a73', 'package_hash', v_hash,
    'line_count', v_n, 'total', v_t, 'checks', v_checks,
    'balances_now', jsonb_build_object('A10', _cfo_corr_5300000_acct('A10'), 'A3', _cfo_corr_5300000_acct('A3'), 'E3', _cfo_corr_5300000_acct('E3')),
    'evaluated_at', now());
END $$;
REVOKE ALL ON FUNCTION public._cfo_corr_5300000_evaluate() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cfo_corr_5300000_preflight()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb; v_id uuid;
BEGIN
  IF NOT (public.is_bucket_a_approver(auth.uid()) OR public.has_role(auth.uid(),'cfo'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO approvers can run this pre-flight';
  END IF;
  v := public._cfo_corr_5300000_evaluate();
  INSERT INTO cfo_corr_5300000_events(event_type, actor, package_hash, details)
  VALUES (CASE WHEN (v->>'pass')::boolean THEN 'preflight_passed' ELSE 'preflight_blocked' END, auth.uid(), v->>'package_hash', v)
  RETURNING id INTO v_id;
  RETURN v || jsonb_build_object('preflight_id', v_id,
    'already_posted', EXISTS (SELECT 1 FROM cfo_corr_5300000_events WHERE event_type='posting_committed'),
    'can_authorize', public.is_bucket_a_approver(auth.uid()));
END $$;
REVOKE ALL ON FUNCTION public.cfo_corr_5300000_preflight() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_corr_5300000_preflight() TO authenticated;

CREATE OR REPLACE FUNCTION public.cfo_corr_5300000_post(p_preflight_id uuid, p_package_hash text, p_confirmation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pf cfo_corr_5300000_events; v jsonb; v_after jsonb; r record; v_gid uuid; v_groups jsonb := '[]';
  v_legs int; v_dr numeric; v_cr numeric; v_badleg int; v_other int; v_err text; v_ev uuid;
BEGIN
  IF NOT public.is_bucket_a_approver(auth.uid()) THEN
    RAISE EXCEPTION 'Only an authorised CFO approver can post this correction';
  END IF;
  IF p_package_hash IS DISTINCT FROM '262bf75c20610b3682ce31a4ff508006' THEN
    RAISE EXCEPTION 'Package fingerprint does not match the approved package';
  END IF;
  IF p_confirmation IS DISTINCT FROM 'AUTHORIZE CORRECTION CORR-2026-10-08-9fc656402a73' THEN
    RAISE EXCEPTION 'Type AUTHORIZE CORRECTION CORR-2026-10-08-9fc656402a73 exactly to authorise';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cfo_corr_5300000_post'));
  IF EXISTS (SELECT 1 FROM cfo_corr_5300000_events WHERE event_type='posting_committed') THEN
    RAISE EXCEPTION 'This correction package has already been posted';
  END IF;
  SELECT * INTO v_pf FROM cfo_corr_5300000_events WHERE id = p_preflight_id;
  IF v_pf.id IS NULL OR v_pf.event_type <> 'preflight_passed' OR v_pf.actor IS DISTINCT FROM auth.uid()
     OR v_pf.created_at < now() - interval '30 minutes'
     OR v_pf.package_hash IS DISTINCT FROM p_package_hash
     OR v_pf.id <> (SELECT id FROM cfo_corr_5300000_events WHERE event_type LIKE 'preflight%' ORDER BY created_at DESC LIMIT 1) THEN
    RAISE EXCEPTION 'Run a fresh pre-flight (your own, passed, latest, under 30 minutes old) before authorising';
  END IF;

  v := public._cfo_corr_5300000_evaluate();
  IF NOT (v->>'pass')::boolean OR v->>'package_hash' <> p_package_hash THEN
    INSERT INTO cfo_corr_5300000_events(event_type, actor, package_hash, preflight_id, details)
    VALUES ('posting_blocked', auth.uid(), v->>'package_hash', p_preflight_id, v);
    RETURN jsonb_build_object('status','blocked','message','POSTING BLOCKED - APPROVED PACKAGE HAS CHANGED','evaluation',v);
  END IF;

  BEGIN  -- savepoint: any failure undoes both lines
    FOR r IN SELECT * FROM cfo_corr_5300000_lines ORDER BY line_no LOOP
      IF EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key = r.idempotency_key) THEN
        RAISE EXCEPTION 'Idempotency key already exists: %', r.idempotency_key;
      END IF;
      v_gid := public.create_ledger_transaction(jsonb_build_array(
        jsonb_build_object('amount', r.amount, 'direction', r.receivable_leg_direction, 'category', r.receivable_leg_category,
          'ledger_scope','bridge','classification','production','source_table', r.post_source_table,'source_id', r.post_source_id,
          'description','CORR-2026-10-08-9fc656402a73 '||r.label||': Dr '||r.debit_account||' / Cr '||r.credit_account
            ||'. Sources '||array_to_string(r.source_groups,', ')||'. Fingerprint 262bf75c20610b3682ce31a4ff508006. CFO authorised.'),
        jsonb_build_object('amount', r.amount, 'direction', r.equity_leg_direction, 'category','receivable_restatement_equity',
          'ledger_scope','platform','classification','production','source_table', r.post_source_table,'source_id', r.post_source_id,
          'description','CORR-2026-10-08-9fc656402a73 '||r.label||' equity counterpart. Sources '||array_to_string(r.source_groups,', ')||'.')
        ), r.idempotency_key, false);
      v_groups := v_groups || jsonb_build_object('line_no', r.line_no, 'idempotency_key', r.idempotency_key, 'group_id', v_gid);
    END LOOP;

    SELECT count(*), sum(amount) FILTER (WHERE (category='receivable_restatement_equity' AND direction='cash_in')
                                           OR (category='rent_plan_receivable_restatement' AND direction='cash_in')),
           sum(amount) FILTER (WHERE (category='receivable_restatement_equity' AND direction='cash_out')
                                  OR (category='agent_advance_receivable_opening' AND direction='cash_out')),
           count(*) FILTER (WHERE wallet_id IS NOT NULL OR user_id IS NOT NULL OR ledger_scope NOT IN ('bridge','platform')
             OR NOT ((idempotency_key='cfo-corr-5300000:C1:fbfa846f' AND amount=5100000 AND source_id='9f6e8edd-29ea-42fa-9662-09583449542e'
                       AND ((category='agent_advance_receivable_opening' AND direction='cash_out') OR (category='receivable_restatement_equity' AND direction='cash_in')))
                  OR (idempotency_key='cfo-corr-5300000:C2:cecd73db' AND amount=200000 AND source_id='2a1d52d4-8d4b-48f6-a2fa-34643ba7b6f4'
                       AND ((category='rent_plan_receivable_restatement' AND direction='cash_in') OR (category='receivable_restatement_equity' AND direction='cash_out'))))
             OR description NOT LIKE '%262bf75c20610b3682ce31a4ff508006%' AND category <> 'receivable_restatement_equity')
      INTO v_legs, v_dr, v_cr, v_badleg
      FROM general_ledger WHERE idempotency_key LIKE 'cfo-corr-5300000:%';
    SELECT count(*) INTO v_other FROM general_ledger
     WHERE created_at >= now() AND COALESCE(idempotency_key,'') NOT LIKE 'cfo-corr-5300000:%';
    v_after := jsonb_build_object('A10', _cfo_corr_5300000_acct('A10'), 'A3', _cfo_corr_5300000_acct('A3'), 'E3', _cfo_corr_5300000_acct('E3'));
    IF v_legs <> 4 OR v_dr <> 5300000 OR v_cr <> 5300000 OR v_badleg <> 0 OR v_other <> 0
       OR (SELECT count(DISTINCT transaction_group_id) FROM general_ledger WHERE idempotency_key='cfo-corr-5300000:C1:fbfa846f') <> 1
       OR (SELECT count(DISTINCT transaction_group_id) FROM general_ledger WHERE idempotency_key='cfo-corr-5300000:C2:cecd73db') <> 1
       OR (v->'balances_now'->>'A10')::numeric - (v_after->>'A10')::numeric <> 5100000
       OR (v_after->>'A3')::numeric - (v->'balances_now'->>'A3')::numeric <> 200000 THEN
      RAISE EXCEPTION 'Post-check failed: legs %, debits %, credits %, bad legs %, unrelated legs %, balances %', v_legs, v_dr, v_cr, v_badleg, v_other, v_after;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    INSERT INTO cfo_corr_5300000_events(event_type, actor, package_hash, preflight_id, details)
    VALUES ('posting_failed', auth.uid(), p_package_hash, p_preflight_id, jsonb_build_object('error', v_err, 'rolled_back', true, 'pre_evaluation', v));
    RETURN jsonb_build_object('status','rolled_back','message','Posting failed and was fully rolled back: '||v_err);
  END;

  INSERT INTO cfo_corr_5300000_events(event_type, actor, package_hash, preflight_id, details)
  VALUES ('posting_committed', auth.uid(), p_package_hash, p_preflight_id,
    jsonb_build_object('authorized_by', auth.uid(), 'authorized_at', now(), 'journal_groups', v_groups,
      'legs', v_legs, 'debits', v_dr, 'credits', v_cr, 'balances_before', v->'balances_now', 'balances_after', v_after))
  RETURNING id INTO v_ev;
  RETURN jsonb_build_object('status','committed','event_id', v_ev, 'lines', 2, 'amount', 5300000, 'legs', v_legs,
    'debits', v_dr, 'credits', v_cr, 'balances_before', v->'balances_now', 'balances_after', v_after);
END $$;
REVOKE ALL ON FUNCTION public.cfo_corr_5300000_post(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_corr_5300000_post(uuid,text,text) TO authenticated;