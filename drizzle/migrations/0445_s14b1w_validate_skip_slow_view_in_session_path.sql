CREATE OR REPLACE FUNCTION public.fin_s14b1w_validate(p_mode text DEFAULT 'before')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $f$
DECLARE m jsonb; a jsonb; v_ok boolean := true; v_out jsonb := '[]'::jsonb;
  v_fp text; v_n int; v_s numeric; v_p record; v_c numeric; v_u numeric; v_keys_ok boolean;
BEGIN
  -- v_user_wallet_strict scans the whole ledger (~8s) and exceeds the signed-in statement timeout;
  -- it is checked separately read-only. The two per-user rule paths are checked here.
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
    IF NOT v_keys_ok OR v_c <> (a->>'target_withdrawable')::numeric OR v_u <> v_c
       OR v_p.withdrawable <> (CASE WHEN p_mode='after' THEN a->>'target_withdrawable' ELSE a->>'stored_withdrawable' END)::numeric
       OR ((a->>'target_withdrawable')::numeric - (a->>'stored_withdrawable')::numeric) <> (a->>'adjustment')::numeric
    THEN v_ok := false; END IF;
    v_out := v_out || jsonb_build_object('user_id',a->>'user_id','keys_ok',v_keys_ok,'stored',v_p.withdrawable,
      'calc',v_c,'uws',v_u,'target',a->>'target_withdrawable');
  END LOOP;
  RETURN jsonb_build_object('all_ok',v_ok,'fingerprint',v_fp,'restore_lines',v_n,'restore_total',v_s,'mode',p_mode,'agents',v_out);
END $f$;