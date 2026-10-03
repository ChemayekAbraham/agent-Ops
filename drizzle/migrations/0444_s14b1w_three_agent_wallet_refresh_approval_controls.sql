CREATE TABLE public.fin_s14b1w_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_fingerprint text NOT NULL,
  manifest jsonb NOT NULL,
  authorization_scope jsonb NOT NULL,
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  earliest_execution_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  reason text NOT NULL,
  executed_at timestamptz,
  executed_by uuid,
  execution_result jsonb
);
GRANT SELECT ON public.fin_s14b1w_approvals TO authenticated;
GRANT ALL ON public.fin_s14b1w_approvals TO service_role;
ALTER TABLE public.fin_s14b1w_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO approvers read s14b1w approvals" ON public.fin_s14b1w_approvals
  FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));

CREATE OR REPLACE FUNCTION public.fin_s14b1w_manifest_text()
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $m$ SELECT $txt${"agents":[{"adjustment":"3200.00","name":"Wafula","restoration_keys":[["batch1_restore:s14b1:66270144-9167-4105-8b65-48641d010e41:commission:dr","800.00"],["batch1_restore:s14b1:68339a67-5b41-42aa-995d-68c76ebce18d:commission:dr","800.00"],["batch1_restore:s14b1:af05652d-1fdb-4916-8f91-8bf2b9f238a6:commission:dr","800.00"],["batch1_restore:s14b1:f52b56cf-740d-4764-9f51-ba396c056c07:commission:dr","800.00"]],"stored_withdrawable":"511.36","target_withdrawable":"3711.36","user_id":"d5304353-9b99-42e5-bcda-28ba96cc0bbc"},{"adjustment":"34190.10","name":"Mugisha","restoration_keys":[["batch1_restore:s14b1:2c370a19-60b4-4193-b376-520cb9f4717a:commission:dr","1396.70"],["batch1_restore:s14b1:31ebfec0-171b-417d-9658-b62f2cbcb683:commission:dr","1396.70"],["batch1_restore:s14b1:45ebae2e-dfd6-4e92-8495-155fad2cd8cf:commission:dr","10000.00"],["batch1_restore:s14b1:91e20d2a-26f5-48ed-8455-2f4d2ce31e00:commission:dr","10000.00"],["batch1_restore:s14b1:c409aff9-d0a9-48df-a4b0-4b896f6d35f5:commission:dr","1396.70"],["batch1_restore:s14b1:d194258c-eee4-431b-bb5b-2655fe8b5928:commission:dr","10000.00"]],"stored_withdrawable":"313428.40","target_withdrawable":"347618.50","user_id":"dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa"},{"adjustment":"2410.32","name":"Nyanzi","restoration_keys":[["batch1_restore:s14b1:298d14ff-6bf5-4702-8642-147de0a414fb:commission:dr","736.00"],["batch1_restore:s14b1:b8f8f6d9-0fdf-42dd-810c-e09d3f71f079:commission:dr","558.72"],["batch1_restore:s14b1:f110f18e-9165-4e09-9f7f-96e2fe76ba49:commission:dr","1115.60"]],"stored_withdrawable":"813.44","target_withdrawable":"3223.76","user_id":"e1bb1b7c-14a6-4a25-a82c-dffe345b7170"}],"excluded_users":["0488c66a-9605-4638-9046-09d07d9109c7"],"line_count":13,"package":"s14b1_wallet_refresh_3agents_v1","refresh_wallet_projection_for_def_md5":"2809298bcadf91cef17fe5e8820062ba","rule_migration":"0443 batch1_restore_wallet_rule_exception","source_batch1_approval":"651ab0f3-617b-48f9-bf01-a90104831dea","source_batch1_package_hash":"090c28fb7f76488ba1bc2ab4cb709ae70cecaa8b0d8f4a558f4766fe6c0342dc","total_adjustment":"39800.42","wallet_strict_for_user_def_md5":"1a9dddac375ce512d557c604613e1be1"}$txt$::text $m$;

CREATE OR REPLACE FUNCTION public.fin_s14b1w_validate(p_mode text DEFAULT 'before')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $f$
DECLARE m jsonb; a jsonb; v_ok boolean := true; v_out jsonb := '[]'::jsonb;
  v_fp text; v_n int; v_s numeric; v_p record; v_c numeric; v_u numeric; v_v numeric; v_keys_ok boolean;
BEGIN
  v_fp := encode(sha256(convert_to(public.fin_s14b1w_manifest_text(),'UTF8')),'hex');
  m := public.fin_s14b1w_manifest_text()::jsonb;
  IF v_fp <> '1e164ea027f8d01e0503a200f244d3ec12ad2638b1d0cb6e3974b6be16baba80' THEN v_ok := false; END IF;
  IF md5(pg_get_functiondef('public.wallet_strict_for_user(uuid)'::regprocedure)) <> m->>'wallet_strict_for_user_def_md5'
  OR md5(pg_get_functiondef('public.refresh_wallet_projection_for(uuid)'::regprocedure)) <> m->>'refresh_wallet_projection_for_def_md5'
  THEN v_ok := false; v_out := v_out || jsonb_build_object('check','rule_definition','ok',false); END IF;
  SELECT count(*), coalesce(sum(amount),0) INTO v_n, v_s FROM general_ledger
   WHERE ledger_scope='wallet' AND direction IN ('credit','cash_in') AND idempotency_key LIKE 'batch1\_restore:s14b1:%';
  IF v_n <> 13 OR v_s <> 39800.42 THEN v_ok := false; END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(m->'agents') LOOP
    v_keys_ok := (SELECT count(*) = jsonb_array_length(a->'restoration_keys') FROM jsonb_array_elements(a->'restoration_keys') kk
      JOIN general_ledger gl ON gl.idempotency_key = kk->>0 AND gl.amount = (kk->>1)::numeric
       AND gl.user_id = (a->>'user_id')::uuid AND gl.ledger_scope='wallet' AND gl.direction IN ('credit','cash_in')
       AND gl.category='system_balance_correction' AND gl.source_table='fin_s14b1r_lines');
    SELECT * INTO v_p FROM wallet_balances_projection WHERE user_id = (a->>'user_id')::uuid;
    SELECT withdrawable INTO v_c FROM wallet_strict_for_user((a->>'user_id')::uuid);
    SELECT withdrawable INTO v_u FROM user_wallet_strict((a->>'user_id')::uuid);
    SELECT withdrawable INTO v_v FROM v_user_wallet_strict WHERE user_id = (a->>'user_id')::uuid;
    IF NOT v_keys_ok OR v_c <> (a->>'target_withdrawable')::numeric OR v_u <> v_c OR v_v <> v_c
       OR v_p.withdrawable <> (CASE WHEN p_mode='after' THEN a->>'target_withdrawable' ELSE a->>'stored_withdrawable' END)::numeric
       OR ((a->>'target_withdrawable')::numeric - (a->>'stored_withdrawable')::numeric) <> (a->>'adjustment')::numeric
    THEN v_ok := false; END IF;
    v_out := v_out || jsonb_build_object('user_id',a->>'user_id','keys_ok',v_keys_ok,'stored',v_p.withdrawable,
      'calc',v_c,'uws',v_u,'v_uws',v_v,'target',a->>'target_withdrawable');
  END LOOP;
  RETURN jsonb_build_object('all_ok',v_ok,'fingerprint',v_fp,'restore_lines',v_n,'restore_total',v_s,'mode',p_mode,'agents',v_out);
END $f$;

CREATE OR REPLACE FUNCTION public.cfo_s14b1w_approve(p_fingerprint text, p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE v_id uuid; v jsonb;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'S14B1W_NOT_CFO'; END IF;
  IF p_fingerprint IS DISTINCT FROM '1e164ea027f8d01e0503a200f244d3ec12ad2638b1d0cb6e3974b6be16baba80' THEN RAISE EXCEPTION 'S14B1W_FINGERPRINT_MISMATCH'; END IF;
  IF length(btrim(coalesce(p_reason,''))) < 10 THEN RAISE EXCEPTION 'S14B1W_REASON_REQUIRED'; END IF;
  IF EXISTS (SELECT 1 FROM fin_s14b1w_approvals WHERE executed_at IS NOT NULL) THEN RAISE EXCEPTION 'S14B1W_ALREADY_EXECUTED'; END IF;
  IF EXISTS (SELECT 1 FROM fin_s14b1w_approvals WHERE executed_at IS NULL AND expires_at > now()) THEN RAISE EXCEPTION 'S14B1W_OPEN_APPROVAL_EXISTS'; END IF;
  v := public.fin_s14b1w_validate('before');
  IF NOT (v->>'all_ok')::boolean THEN RAISE EXCEPTION 'S14B1W_VALIDATION_FAILED: %', v; END IF;
  INSERT INTO fin_s14b1w_approvals (package_fingerprint, manifest, authorization_scope, approved_by, earliest_execution_at, expires_at, reason)
  VALUES (p_fingerprint, public.fin_s14b1w_manifest_text()::jsonb,
    jsonb_build_object('authorizes','stored wallet withdrawable/total_visible refresh for the 3 listed users only',
      'not_authorized', jsonb_build_array('ledger posting','wallet transactions','payments','rent plans','commissions','referrals','recruiter','lc1 bonuses','landlord bonuses','float','advance','pending/held','any other user')),
    auth.uid(), now() + interval '5 minutes', now() + interval '12 hours', p_reason)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 's14b1w_refresh_approved', 'fin_s14b1w_approvals', v_id::text, p_reason, jsonb_build_object('fingerprint', p_fingerprint));
  RETURN v_id;
END $f$;

CREATE OR REPLACE FUNCTION public.cfo_s14b1w_execute(p_approval_id uuid, p_confirmation text, p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE r fin_s14b1w_approvals; v jsonb; a jsonb; v_before record; v_after record; v_res jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'S14B1W_NOT_CFO'; END IF;
  IF p_confirmation IS DISTINCT FROM 'EXECUTE BATCH 1 WALLET REFRESH' THEN RAISE EXCEPTION 'S14B1W_CONFIRMATION_MISMATCH'; END IF;
  SELECT * INTO r FROM fin_s14b1w_approvals WHERE id = p_approval_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'S14B1W_APPROVAL_NOT_FOUND'; END IF;
  IF r.executed_at IS NOT NULL THEN RAISE EXCEPTION 'S14B1W_ALREADY_EXECUTED'; END IF;
  IF p_fingerprint IS DISTINCT FROM r.package_fingerprint OR p_fingerprint IS DISTINCT FROM '1e164ea027f8d01e0503a200f244d3ec12ad2638b1d0cb6e3974b6be16baba80'
     OR r.manifest IS DISTINCT FROM public.fin_s14b1w_manifest_text()::jsonb THEN RAISE EXCEPTION 'S14B1W_FINGERPRINT_MISMATCH'; END IF;
  IF now() < r.earliest_execution_at THEN RAISE EXCEPTION 'S14B1W_WAITING_PERIOD'; END IF;
  IF now() > r.expires_at THEN RAISE EXCEPTION 'S14B1W_APPROVAL_EXPIRED'; END IF;
  v := public.fin_s14b1w_validate('before');
  IF NOT (v->>'all_ok')::boolean THEN RAISE EXCEPTION 'S14B1W_VALIDATION_FAILED: %', v; END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(r.manifest->'agents') LOOP
    SELECT * INTO v_before FROM wallet_balances_projection WHERE user_id=(a->>'user_id')::uuid FOR UPDATE;
    PERFORM public.refresh_wallet_projection_for((a->>'user_id')::uuid);
    SELECT * INTO v_after FROM wallet_balances_projection WHERE user_id=(a->>'user_id')::uuid;
    IF v_after.withdrawable <> (a->>'target_withdrawable')::numeric
       OR v_after.float_balance <> v_before.float_balance OR v_after.float_balance_raw <> v_before.float_balance_raw
       OR v_after.advance_balance <> v_before.advance_balance OR v_after.pending_holds <> v_before.pending_holds
       OR v_after.restricted_held <> v_before.restricted_held
    THEN RAISE EXCEPTION 'S14B1W_POSTCHECK_FAILED: %', a->>'user_id'; END IF;
    v_res := v_res || jsonb_build_object('user_id',a->>'user_id','before',v_before.withdrawable,'after',v_after.withdrawable);
  END LOOP;
  UPDATE fin_s14b1w_approvals SET executed_at=now(), executed_by=auth.uid(), execution_result=jsonb_build_object('agents',v_res) WHERE id=r.id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 's14b1w_refresh_executed', 'fin_s14b1w_approvals', r.id::text, 'Batch 1 three-agent wallet refresh executed under approval', jsonb_build_object('result',v_res));
  RETURN jsonb_build_object('ok',true,'agents',v_res);
END $f$;

REVOKE ALL ON FUNCTION public.fin_s14b1w_validate(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_s14b1w_approve(text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_s14b1w_execute(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_s14b1w_validate(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_s14b1w_approve(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_s14b1w_execute(uuid,text,text) TO authenticated;