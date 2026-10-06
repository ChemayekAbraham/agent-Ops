-- Batch 1 Restoration control fix: restore Rent Plans by delta, never by overwrite.
-- Two plans (1240a589, 5dd7fff9) received genuine UGX 5,000 payments after Batch 1; overwriting would erase them.
-- Pins the current live values of the 13 plans; execution fails closed if any differs. No financial records changed.
CREATE TABLE public.fin_s14b1r_plan_pins (
  rent_request_id      uuid PRIMARY KEY,
  amount_repaid_pinned numeric(18,2) NOT NULL,
  status_pinned        text NOT NULL
);
GRANT SELECT ON public.fin_s14b1r_plan_pins TO authenticated;
GRANT ALL ON public.fin_s14b1r_plan_pins TO service_role;
ALTER TABLE public.fin_s14b1r_plan_pins ENABLE ROW LEVEL SECURITY;
CREATE POLICY s14b1r_pins_cfo ON public.fin_s14b1r_plan_pins FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));
INSERT INTO public.fin_s14b1r_plan_pins VALUES ('090754f1-99eb-4f45-9493-a1fdc0cb3906'::uuid,117231.00::numeric,'repaying'),('0b0b7e91-0765-4527-93aa-633828f5753a'::uuid,289000.00::numeric,'repaying'),('1019b84b-b964-4d38-a97e-5d56978499e0'::uuid,92500.00::numeric,'repaying'),('1240a589-088c-43e3-aee0-3dfab6ea576f'::uuid,338066.00::numeric,'repaying'),('2ca84e52-973b-4ed6-a5b8-5bc28ba6cd84'::uuid,323000.00::numeric,'repaying'),('3948339e-609c-4bc2-bf1f-cea49ff2be2c'::uuid,138793.00::numeric,'repaying'),('5dd7fff9-258c-4c12-98f9-0693a9cb8ec3'::uuid,316033.00::numeric,'repaying'),('7dc8482b-85ef-4d40-b08f-d6e04745af92'::uuid,266800.00::numeric,'repaying'),('9256fe0a-b320-4c84-9212-f645ef5a422b'::uuid,79920.00::numeric,'repaying'),('9d4e941e-1cfc-4506-a554-5af3d5daca5e'::uuid,215789.00::numeric,'repaying'),('b76711ef-9574-49c0-b02b-57b1133c4d38'::uuid,92400.00::numeric,'repaying'),('be7f78ad-1b16-4c7f-ba23-5af2886fd9a6'::uuid,254000.00::numeric,'repaying'),('cd49828e-3635-4631-a015-5676342a9e4f'::uuid,53904.00::numeric,'repaying');
CREATE TRIGGER trg_s14b1r_pins_frozen BEFORE UPDATE OR DELETE ON public.fin_s14b1r_plan_pins FOR EACH ROW EXECUTE FUNCTION public.fin_s14b1r_freeze();
CREATE TRIGGER trg_s14b1r_pins_noins AFTER INSERT ON public.fin_s14b1r_plan_pins FOR EACH STATEMENT EXECUTE FUNCTION public.fin_s14b1r_no_insert();

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
    JOIN fin_s14b1r_plan_pins pin ON pin.rent_request_id=p.rent_request_id
   WHERE rr.amount_repaid::numeric(18,2) <> pin.amount_repaid_pinned OR rr.status <> pin.status_pinned
      OR rr.total_repayment::numeric(18,2) <> p.total_repayment
      OR pin.amount_repaid_pinned + p.restore_amount > p.total_repayment
      OR CASE WHEN pin.amount_repaid_pinned + p.restore_amount >= p.total_repayment THEN 'completed' ELSE pin.status_pinned END <> p.status_before;
  SELECT count(*) INTO n FROM fin_s14b1r_plan_pins;
  IF n <> 13 OR (SELECT sum(amount_repaid_pinned) FROM fin_s14b1r_plan_pins) <> 2577436 THEN bad := bad + 100; END IF;
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
END 
$f$;

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
    UPDATE rent_requests rr SET amount_repaid = pin.amount_repaid_pinned + p.restore_amount, status = p.status_before
      FROM fin_s14b1r_plan_pins pin
     WHERE rr.id = p.rent_request_id AND pin.rent_request_id = p.rent_request_id
       AND rr.amount_repaid::numeric(18,2) = pin.amount_repaid_pinned AND rr.status = pin.status_pinned;
    IF NOT FOUND THEN RAISE EXCEPTION 'S14B1R_PLAN_CHANGED %', p.rent_request_id; END IF;
    n_plans := n_plans + 1;
    INSERT INTO audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 's14b1r_tenant_balance_restored', 'rent_requests', p.rent_request_id::text,
            'Batch 1 Restoration: undo Stage 14 Batch 1 tenant balance change',
            jsonb_build_object('approval_id', p_approval_id, 'restored', p.restore_amount, 'status_after', p.status_before));
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
END 
$f$;

REVOKE ALL ON FUNCTION public.fin_s14b1r_validate(), public.cfo_s14b1r_execute(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_s14b1r_execute(uuid, text, text) TO authenticated;
