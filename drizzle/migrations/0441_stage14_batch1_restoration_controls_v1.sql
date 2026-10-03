-- Stage 14 Batch 1 RESTORATION controls, package S14B1-RESTORE-v1, fingerprint 090c28fb7f76488ba1bc2ab4cb709ae70cecaa8b0d8f4a558f4766fe6c0342dc
-- CONTROL INSTALLATION ONLY. New frozen snapshot table, approval table, validation, approval and a separate gated executor.
-- Nothing here posts ledger entries, moves wallets, changes Rent Plans or clears collection markers.
-- The original S14B1-v3 tables/functions/approval are not modified.

CREATE TABLE public.fin_s14b1r_lines (
  orig_leg_id          uuid PRIMARY KEY,
  orig_idempotency_key text NOT NULL UNIQUE,
  orig_reference_id    text NOT NULL,
  orig_group_id        uuid NOT NULL,
  user_id              uuid,
  amount               numeric NOT NULL CHECK (amount > 0),
  orig_direction       text NOT NULL CHECK (orig_direction IN ('cash_in','cash_out')),
  category             text NOT NULL,
  ledger_scope         text NOT NULL,
  recipient_type       text,
  wallet_bucket        text,
  rent_request_id      uuid,
  collection_id        uuid NOT NULL
);
CREATE TABLE public.fin_s14b1r_approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_version  text NOT NULL,
  package_title    text NOT NULL,
  package_hash     text NOT NULL,
  approved_by      uuid NOT NULL,
  approved_at      timestamptz NOT NULL DEFAULT now(),
  approved_totals  jsonb NOT NULL,
  exclusions       jsonb NOT NULL,
  reason           text NOT NULL CHECK (length(btrim(reason)) >= 10),
  executed_at      timestamptz,
  executed_by      uuid,
  execution_result jsonb
);
CREATE UNIQUE INDEX fin_s14b1r_one_execution ON public.fin_s14b1r_approvals ((true)) WHERE executed_at IS NOT NULL;
CREATE UNIQUE INDEX general_ledger_batch1_restore_key_uniq ON public.general_ledger (idempotency_key) WHERE idempotency_key LIKE 'batch1_restore:%';

GRANT SELECT ON public.fin_s14b1r_lines, public.fin_s14b1r_approvals TO authenticated;
GRANT ALL ON public.fin_s14b1r_lines, public.fin_s14b1r_approvals TO service_role;
ALTER TABLE public.fin_s14b1r_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_s14b1r_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY s14b1r_lines_cfo ON public.fin_s14b1r_lines     FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));
CREATE POLICY s14b1r_appr_cfo  ON public.fin_s14b1r_approvals FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));

-- Frozen snapshot of the 66 executed Batch 1 ledger lines (read-only copy, no ledger change)
INSERT INTO public.fin_s14b1r_lines
SELECT g.id, g.idempotency_key, g.reference_id, g.transaction_group_id, g.user_id, g.amount, g.direction, g.category,
       g.ledger_scope, g.recipient_type, g.wallet_bucket, g.rent_request_id, g.source_id
  FROM public.general_ledger g WHERE g.idempotency_key LIKE 's14b1:%';

CREATE OR REPLACE FUNCTION public.fin_s14b1r_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $f$
BEGIN
  IF TG_TABLE_NAME = 'fin_s14b1r_approvals' AND TG_OP = 'UPDATE' THEN
    IF OLD.executed_at IS NULL AND NEW.executed_at IS NOT NULL
       AND (NEW.id, NEW.package_version, NEW.package_hash, NEW.approved_by, NEW.approved_at, NEW.approved_totals, NEW.exclusions, NEW.reason)
         = (OLD.id, OLD.package_version, OLD.package_hash, OLD.approved_by, OLD.approved_at, OLD.approved_totals, OLD.exclusions, OLD.reason)
       AND current_setting('s14b1r.executing', true) = 'on' THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'S14B1R_FROZEN: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $f$;
CREATE TRIGGER trg_s14b1r_lines_frozen BEFORE UPDATE OR DELETE ON public.fin_s14b1r_lines     FOR EACH ROW EXECUTE FUNCTION public.fin_s14b1r_freeze();
CREATE TRIGGER trg_s14b1r_appr_frozen  BEFORE UPDATE OR DELETE ON public.fin_s14b1r_approvals FOR EACH ROW EXECUTE FUNCTION public.fin_s14b1r_freeze();
CREATE OR REPLACE FUNCTION public.fin_s14b1r_no_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $f$
BEGIN RAISE EXCEPTION 'S14B1R_FROZEN: package rows cannot be added'; END $f$;
CREATE TRIGGER trg_s14b1r_lines_noins AFTER INSERT ON public.fin_s14b1r_lines FOR EACH STATEMENT EXECUTE FUNCTION public.fin_s14b1r_no_insert();

-- Deterministic package fingerprint (same formula as the pre-execution snapshot)
CREATE OR REPLACE FUNCTION public.fin_s14b1r_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT encode(sha256(convert_to(
    (SELECT string_agg('batch1_restore:'||orig_idempotency_key||'|'||orig_group_id||'|'||category||'|'||ledger_scope||'|'||
                       CASE orig_direction WHEN 'cash_in' THEN 'cash_out' ELSE 'cash_in' END||'|'||amount||'|'||coalesce(user_id::text,''),
                       E'\n' ORDER BY orig_idempotency_key) FROM public.fin_s14b1r_lines)
    ||E'\n#plans\n'||(SELECT string_agg(rent_request_id||'|'||restore_amount, E'\n' ORDER BY rent_request_id) FROM public.fin_s14b1_package_plans)
    ||E'\n#collections\n'||(SELECT string_agg(collection_id::text, E'\n' ORDER BY collection_id) FROM public.fin_s14b1_package_lines WHERE kind='cash'),
    'UTF8')), 'hex')
$f$;

CREATE OR REPLACE FUNCTION public.fin_s14b1r_validate() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $f$
DECLARE v jsonb := '{}'::jsonb; ok boolean := true; n int; s numeric; s2 numeric; bad int;
BEGIN
  v := v || jsonb_build_object('fingerprint', public.fin_s14b1r_fingerprint());
  ok := ok AND public.fin_s14b1r_fingerprint() = '090c28fb7f76488ba1bc2ab4cb709ae70cecaa8b0d8f4a558f4766fe6c0342dc';

  SELECT count(*), count(DISTINCT orig_group_id), sum(amount) FILTER (WHERE orig_direction='cash_in'), sum(amount) FILTER (WHERE orig_direction='cash_out')
    INTO n, bad, s, s2 FROM fin_s14b1r_lines;
  v := v || jsonb_build_object('lines', n, 'entries', bad, 'debits', s, 'credits', s2);
  ok := ok AND n = 66 AND bad = 33 AND s = 523485.42 AND s2 = 523485.42;
  SELECT count(*) INTO bad FROM (SELECT orig_group_id FROM fin_s14b1r_lines GROUP BY 1
     HAVING sum(CASE WHEN orig_direction='cash_in' THEN amount ELSE -amount END) <> 0) x;
  ok := ok AND bad = 0;

  -- live Batch 1 ledger must still match the frozen snapshot exactly
  SELECT count(*) INTO n FROM general_ledger WHERE idempotency_key LIKE 's14b1:%';
  SELECT count(*) INTO bad FROM fin_s14b1r_lines l WHERE NOT EXISTS (
    SELECT 1 FROM general_ledger g WHERE g.id=l.orig_leg_id AND g.idempotency_key=l.orig_idempotency_key AND g.transaction_group_id=l.orig_group_id
      AND g.amount=l.amount AND g.direction=l.orig_direction AND g.category=l.category AND g.ledger_scope=l.ledger_scope
      AND g.user_id IS NOT DISTINCT FROM l.user_id AND g.wallet_bucket IS NOT DISTINCT FROM l.wallet_bucket);
  v := v || jsonb_build_object('live_batch1_legs', n, 'snapshot_mismatch', bad); ok := ok AND n = 66 AND bad = 0;

  -- wallet scope: exactly the three agents, exact amounts, withdrawable bucket only
  SELECT count(*) INTO bad FROM (
    SELECT user_id, sum(amount) a FROM fin_s14b1r_lines WHERE ledger_scope='wallet' GROUP BY 1) x
   FULL JOIN (VALUES ('dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa'::uuid, 34190.10::numeric),
                     ('d5304353-9b99-42e5-bcda-28ba96cc0bbc'::uuid, 3200.00),
                     ('e1bb1b7c-14a6-4a25-a82c-dffe345b7170'::uuid, 2410.32)) e(u, a) ON e.u = x.user_id
   WHERE x.a IS DISTINCT FROM e.a;
  v := v || jsonb_build_object('wallet_scope_mismatch', bad); ok := ok AND bad = 0;
  SELECT count(*) INTO bad FROM fin_s14b1r_lines WHERE ledger_scope='wallet'
     AND (orig_direction <> 'cash_out' OR wallet_bucket IS DISTINCT FROM 'withdrawable' OR recipient_type IS DISTINCT FROM 'user' OR category <> 'system_balance_correction');
  ok := ok AND bad = 0;

  -- 20 collections still carry the Batch 1 removal marker
  SELECT count(*), sum(ac.amount) INTO n, s FROM agent_collections ac
   WHERE ac.id IN (SELECT collection_id FROM fin_s14b1_package_lines WHERE kind='cash')
     AND ac.reversed_at = '2026-10-03 19:11:52.908848+00';
  v := v || jsonb_build_object('collections_marked', n, 'collections_amount', s); ok := ok AND n = 20 AND s = 483685;
  SELECT count(*) INTO bad FROM fin_s14b1r_lines WHERE collection_id NOT IN (SELECT collection_id FROM fin_s14b1_package_lines WHERE kind='cash');
  ok := ok AND bad = 0;

  -- 13 Rent Plans at their post-correction values
  SELECT count(*), sum(restore_amount) INTO n, s FROM fin_s14b1_package_plans;
  ok := ok AND n = 13 AND s = 479685;
  SELECT count(*) INTO bad FROM fin_s14b1_package_plans p JOIN rent_requests rr ON rr.id=p.rent_request_id
   WHERE rr.amount_repaid::numeric(18,2) <> p.amount_repaid_after OR rr.status <> p.status_after OR rr.total_repayment::numeric(18,2) <> p.total_repayment;
  v := v || jsonb_build_object('plans_changed', bad); ok := ok AND bad = 0;
  SELECT count(*) INTO n FROM fin_s14b1_package_plans WHERE rent_request_id='2ca84e52-973b-4ed6-a5b8-5bc28ba6cd84' AND restore_amount=96000;
  ok := ok AND n = 1;

  -- no restoration has happened
  SELECT count(*) INTO n FROM general_ledger WHERE idempotency_key LIKE 'batch1_restore:%' OR reference_id LIKE 'batch1_restore:%';
  v := v || jsonb_build_object('restore_keys', n); ok := ok AND n = 0;

  -- protected corrections untouched
  SELECT count(*), sum(amount) INTO n, s FROM agent_collections WHERE reversed_at='2026-09-16 14:08:40.882504+00';
  v := v || jsonb_build_object('sep16_count', n, 'sep16_amount', s); ok := ok AND n = 1210 AND s = 92656683;
  SELECT count(*) INTO n FROM plan_balance_duplicate_correction_20260929;
  v := v || jsonb_build_object('sep29_rows', n); ok := ok AND n = 31;
  SELECT count(*) INTO n FROM general_ledger WHERE idempotency_key LIKE 's14b2:%';
  v := v || jsonb_build_object('batch2_legs', n); ok := ok AND n = 0;

  v := v || jsonb_build_object('all_ok', ok);
  RETURN v;
END $f$;

CREATE OR REPLACE FUNCTION public.cfo_s14b1r_manifest() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $f$
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'S14B1R_NOT_CFO'; END IF;
  RETURN jsonb_build_object(
    'title', 'Batch 1 Restoration — Accounting Correction',
    'version', 'S14B1-RESTORE-v1',
    'fingerprint', public.fin_s14b1r_fingerprint(),
    'single_use', true,
    'totals', jsonb_build_object('payments',20,'original_amount',483685,'tenant_restoration',479685,'commission_restoration',39800.42,
                                 'entries',33,'lines',66,'debits',523485.42,'credits',523485.42),
    'wallets', jsonb_build_object('Mugisha Emmanuel',34190.10,'Wafula Ronald',3200.00,'Nyanzi Lydia Eseri',2410.32),
    'exclusions', jsonb_build_array('Case 20 UGX 4,000','Unrecovered commission UGX 5,732.40','Recruiter commission UGX 2,835.68',
                                    'Batch 2','16 Sep correction','29 Sep correction','All other payments, wallets and Rent Plans'),
    'approvals', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.approved_at) FROM fin_s14b1r_approvals a),
    'lines', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.orig_idempotency_key) FROM fin_s14b1r_lines l),
    'validation', public.fin_s14b1r_validate());
END $f$;

-- Approval only: records a decision, never executes
CREATE OR REPLACE FUNCTION public.cfo_s14b1r_approve(p_package_hash text, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE v_id uuid; v jsonb;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'S14B1R_NOT_CFO'; END IF;
  IF p_package_hash IS DISTINCT FROM '090c28fb7f76488ba1bc2ab4cb709ae70cecaa8b0d8f4a558f4766fe6c0342dc'
     OR p_package_hash IS DISTINCT FROM public.fin_s14b1r_fingerprint() THEN RAISE EXCEPTION 'S14B1R_HASH_MISMATCH'; END IF;
  IF length(btrim(coalesce(p_reason,''))) < 10 THEN RAISE EXCEPTION 'S14B1R_REASON_REQUIRED'; END IF;
  IF EXISTS (SELECT 1 FROM fin_s14b1r_approvals WHERE executed_at IS NOT NULL) THEN RAISE EXCEPTION 'S14B1R_ALREADY_EXECUTED'; END IF;
  v := public.fin_s14b1r_validate();
  IF NOT (v->>'all_ok')::boolean THEN RAISE EXCEPTION 'S14B1R_VALIDATION_FAILED: %', v; END IF;
  INSERT INTO fin_s14b1r_approvals (package_version, package_title, package_hash, approved_by, approved_totals, exclusions, reason)
  VALUES ('S14B1-RESTORE-v1', 'Batch 1 Restoration — Accounting Correction', p_package_hash, auth.uid(),
          jsonb_build_object('payments',20,'original_amount',483685,'tenant_restoration',479685,'commission_restoration',39800.42,
                             'entries',33,'lines',66,'debits',523485.42,'credits',523485.42,
                             'wallets', jsonb_build_object('dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa',34190.10,'d5304353-9b99-42e5-bcda-28ba96cc0bbc',3200.00,'e1bb1b7c-14a6-4a25-a82c-dffe345b7170',2410.32)),
          jsonb_build_object('case20_excluded',4000,'unrecovered_commission',5732.40,'recruiter_commission',2835.68,
                             'batch2',true,'sep16',true,'sep29',true,'other_records',true),
          p_reason)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 's14b1r_package_approved', 'fin_s14b1r_approvals', v_id::text, p_reason, jsonb_build_object('hash', p_package_hash));
  RETURN v_id;
END $f$;

-- Separate, gated execution step (NOT invoked by this migration)
CREATE OR REPLACE FUNCTION public.cfo_s14b1r_execute(p_approval_id uuid, p_confirmation text, p_package_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE a record; l record; p record; g record; v jsonb; v_grp uuid;
  n_entries int := 0; n_legs int := 0; v_dr numeric := 0; v_cr numeric := 0; n_coll int; n_plans int := 0; n_ref bigint;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'S14B1R_NOT_CFO'; END IF;
  IF p_confirmation IS DISTINCT FROM 'EXECUTE BATCH 1 RESTORATION' THEN RAISE EXCEPTION 'S14B1R_CONFIRMATION_PHRASE_MISMATCH'; END IF;
  IF p_package_hash IS DISTINCT FROM '090c28fb7f76488ba1bc2ab4cb709ae70cecaa8b0d8f4a558f4766fe6c0342dc' THEN RAISE EXCEPTION 'S14B1R_HASH_MISMATCH'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('s14b1r_execute'));
  SELECT * INTO a FROM fin_s14b1r_approvals WHERE id = p_approval_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'S14B1R_APPROVAL_NOT_FOUND'; END IF;
  IF a.executed_at IS NOT NULL OR EXISTS (SELECT 1 FROM fin_s14b1r_approvals WHERE executed_at IS NOT NULL) THEN RAISE EXCEPTION 'S14B1R_ALREADY_EXECUTED'; END IF;
  IF a.package_version <> 'S14B1-RESTORE-v1' OR a.package_hash <> p_package_hash OR a.package_hash <> public.fin_s14b1r_fingerprint() THEN RAISE EXCEPTION 'S14B1R_HASH_MISMATCH'; END IF;
  IF NOT public.is_cfo_approver(a.approved_by) THEN RAISE EXCEPTION 'S14B1R_APPROVER_INVALID'; END IF;
  IF clock_timestamp() < a.approved_at + interval '5 minutes' THEN RAISE EXCEPTION 'S14B1R_WAITING_PERIOD'; END IF;
  IF clock_timestamp() > a.approved_at + interval '24 hours' THEN RAISE EXCEPTION 'S14B1R_APPROVAL_EXPIRED'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('bucket_reclass:' || u::text))
     FROM (SELECT DISTINCT user_id u FROM fin_s14b1r_lines WHERE ledger_scope='wallet' ORDER BY 1) x;
  PERFORM 1 FROM agent_collections WHERE id IN (SELECT collection_id FROM fin_s14b1r_lines) FOR UPDATE;
  PERFORM 1 FROM rent_requests WHERE id IN (SELECT rent_request_id FROM fin_s14b1_package_plans) FOR UPDATE;

  v := public.fin_s14b1r_validate();
  IF NOT (v->>'all_ok')::boolean THEN RAISE EXCEPTION 'S14B1R_VALIDATION_FAILED: %', v; END IF;
  SELECT count(*) INTO n_ref FROM general_ledger WHERE source_table='referrals';

  PERFORM set_config('ledger.authorized', 'true', true);
  FOR g IN SELECT orig_group_id FROM fin_s14b1r_lines GROUP BY 1 ORDER BY 1 LOOP
    v_grp := gen_random_uuid();
    FOR l IN SELECT * FROM fin_s14b1r_lines WHERE orig_group_id = g.orig_group_id ORDER BY orig_idempotency_key LOOP
      INSERT INTO general_ledger (user_id, amount, direction, category, classification, solvency_bypass_reason, source_table, source_id,
                                  reference_id, idempotency_key, recipient_type, wallet_bucket, rent_request_id, description, ledger_scope, transaction_group_id)
      VALUES (l.user_id, l.amount, CASE l.orig_direction WHEN 'cash_in' THEN 'cash_out' ELSE 'cash_in' END, l.category,
              'admin_correction', 'duplicate_reversal', 'fin_s14b1r_lines', l.collection_id,
              'batch1_restore:'||l.orig_reference_id, 'batch1_restore:'||l.orig_idempotency_key, l.recipient_type, l.wallet_bucket, l.rent_request_id,
              'Batch 1 Restoration: reverse Stage 14 Batch 1 leg '||l.orig_leg_id||' (approval '||p_approval_id||')', l.ledger_scope, v_grp);
      n_legs := n_legs + 1;
      IF l.orig_direction = 'cash_out' THEN v_dr := v_dr + l.amount; ELSE v_cr := v_cr + l.amount; END IF;
    END LOOP;
    n_entries := n_entries + 1;
  END LOOP;

  UPDATE agent_collections ac SET reversed_at = NULL,
         notes = coalesce(ac.notes,'') || ' [RESTORED: Batch 1 Restoration, approval '||p_approval_id||']'
   WHERE ac.id IN (SELECT collection_id FROM fin_s14b1_package_lines WHERE kind='cash') AND ac.reversed_at = '2026-10-03 19:11:52.908848+00';
  GET DIAGNOSTICS n_coll = ROW_COUNT;
  IF n_coll <> 20 THEN RAISE EXCEPTION 'S14B1R_COLLECTIONS_RESTORED %', n_coll; END IF;

  FOR p IN SELECT * FROM fin_s14b1_package_plans LOOP
    UPDATE rent_requests SET amount_repaid = p.amount_repaid_before, status = p.status_before
     WHERE id = p.rent_request_id AND amount_repaid::numeric(18,2) = p.amount_repaid_after AND status = p.status_after;
    IF NOT FOUND THEN RAISE EXCEPTION 'S14B1R_PLAN_CHANGED %', p.rent_request_id; END IF;
    n_plans := n_plans + 1;
    INSERT INTO audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 's14b1r_tenant_balance_restored', 'rent_requests', p.rent_request_id::text,
            'Batch 1 Restoration: undo Stage 14 Batch 1 tenant balance change',
            jsonb_build_object('approval_id', p_approval_id, 'before', p.amount_repaid_after, 'after', p.amount_repaid_before, 'restored', p.restore_amount));
  END LOOP;

  IF n_entries <> 33 OR n_legs <> 66 OR v_dr <> 523485.42 OR v_cr <> 523485.42 THEN RAISE EXCEPTION 'S14B1R_TOTALS_POST % % % %', n_entries, n_legs, v_dr, v_cr; END IF;
  IF (SELECT count(*) FROM general_ledger WHERE idempotency_key LIKE 'batch1_restore:%') <> 66 THEN RAISE EXCEPTION 'S14B1R_LEG_COUNT'; END IF;
  IF EXISTS (SELECT 1 FROM general_ledger WHERE idempotency_key LIKE 'batch1_restore:%' GROUP BY transaction_group_id
             HAVING sum(CASE WHEN direction='cash_in' THEN amount ELSE -amount END) <> 0) THEN RAISE EXCEPTION 'S14B1R_UNBALANCED_GROUP'; END IF;
  IF EXISTS (SELECT 1 FROM wallets WHERE user_id IN (SELECT user_id FROM fin_s14b1r_lines WHERE ledger_scope='wallet') AND (withdrawable_balance < 0 OR float_balance < 0))
     THEN RAISE EXCEPTION 'S14B1R_NEGATIVE_WALLET'; END IF;
  IF (SELECT count(*) FROM general_ledger WHERE source_table='referrals') <> n_ref THEN RAISE EXCEPTION 'S14B1R_REFERRAL_PAID_DURING_RUN'; END IF;

  v := jsonb_build_object('approval_id', p_approval_id, 'fingerprint', a.package_hash, 'entries', n_entries, 'legs', n_legs,
                          'debits', v_dr, 'credits', v_cr, 'collections_restored', n_coll, 'plans_restored', n_plans);
  PERFORM set_config('s14b1r.executing', 'on', true);
  UPDATE fin_s14b1r_approvals SET executed_at = now(), executed_by = auth.uid(), execution_result = v WHERE id = p_approval_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 's14b1r_restoration_executed', 'fin_s14b1r_approvals', p_approval_id::text, 'Batch 1 Restoration executed under CFO approval', v);
  INSERT INTO system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('ACCOUNTING_CORRECTION_BATCH_1_RESTORATION', auth.uid(), 'fin_s14b1r_approvals', p_approval_id, v || jsonb_build_object('kind','s14b1_restoration'));
  RETURN v;
END $f$;

REVOKE ALL ON FUNCTION public.fin_s14b1r_fingerprint(), public.fin_s14b1r_validate(), public.cfo_s14b1r_manifest(),
  public.cfo_s14b1r_approve(text, text), public.cfo_s14b1r_execute(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_s14b1r_manifest(), public.cfo_s14b1r_approve(text, text), public.cfo_s14b1r_execute(uuid, text, text) TO authenticated;

DO $c$ BEGIN
  IF (SELECT count(*) FROM public.fin_s14b1r_lines) <> 66 OR public.fin_s14b1r_fingerprint() <> '090c28fb7f76488ba1bc2ab4cb709ae70cecaa8b0d8f4a558f4766fe6c0342dc' THEN
    RAISE EXCEPTION 'S14B1R package fingerprint % differs from reviewed 090c28fb…', public.fin_s14b1r_fingerprint();
  END IF;
END $c$;
