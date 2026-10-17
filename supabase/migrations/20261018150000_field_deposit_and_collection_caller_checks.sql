-- 2026-10-18 (doc 247, step 10): two money functions callable by any signed-in user with no caller check.
--
-- process_verified_field_deposit(batch, finops_user, proof): verifies a field deposit batch. In withdrawable mode it credits the batch's agent wallet
--   with the batch's declared_total (declared by the agent) and marks it verified; the function only checks that the batch is pending, never who is
--   calling or whether Financial Ops verified anything (the proof argument is a caller-supplied string). Its only real caller is the
--   verify-field-deposit edge function, which authenticates the user, checks is_financial_ops_staff, and then calls this through a SERVICE-ROLE
--   client (the mention in FieldDepositQueueCard.tsx is a comment). Closed to service_role only via _fn_lockdown.run.
--
-- validate_and_record_collection(token, method, agent): records an agent's rent collection against a payment token. The browser passes the signed-in
--   agent's own id (RecordAgentCollectionDialog); the function trusted p_agent_id. Now an agent may only record for themselves (service role excepted).
--
-- Already applied to production 2026-10-18. Needs _fn_lockdown.run from migration 20261017140000.
select * from _fn_lockdown.run(array['process_verified_field_deposit'], true);

create or replace function public.validate_and_record_collection(p_token_code text, p_payment_method text, p_agent_id uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_token record; v_float record;
  v_float_before numeric; v_float_after numeric; v_collection_id uuid;
begin
  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if p_agent_id is distinct from v_uid then
      raise exception 'you can only record your own collections' using errcode = '42501';
    end if;
  end if;

  select * into v_token from payment_tokens where token_code = p_token_code and agent_id = p_agent_id;
  if not found then return jsonb_build_object('success', false, 'error', 'Token not found'); end if;
  if v_token.used then return jsonb_build_object('success', false, 'error', 'Token already used'); end if;
  if v_token.expires_at < now() then return jsonb_build_object('success', false, 'error', 'Token has expired'); end if;

  perform reset_agent_float_if_stale(p_agent_id);

  if p_payment_method = 'cash' then
    select * into v_float from agent_float_limits where agent_id = p_agent_id;
    if found then
      if v_float.collected_today + v_token.amount > v_float.float_limit then
        return jsonb_build_object('success', false, 'error', 'Float capacity exceeded. Remaining: ' || (v_float.float_limit - v_float.collected_today)::text);
      end if;
      v_float_before := v_float.collected_today;
      v_float_after := v_float.collected_today + v_token.amount;
      update agent_float_limits set collected_today = v_float_after, updated_at = now() where agent_id = p_agent_id;
    else
      v_float_before := 0; v_float_after := 0;
    end if;
  else
    select collected_today into v_float_before from agent_float_limits where agent_id = p_agent_id;
    v_float_before := coalesce(v_float_before, 0); v_float_after := v_float_before;
  end if;

  update payment_tokens set used = true, used_at = now() where id = v_token.id;

  insert into agent_collections (agent_id, tenant_id, token_id, amount, payment_method, float_before, float_after)
  values (p_agent_id, v_token.tenant_id, v_token.id, v_token.amount, p_payment_method::collection_payment_method, v_float_before, v_float_after)
  returning id into v_collection_id;

  return jsonb_build_object('success', true, 'collection_id', v_collection_id, 'amount', v_token.amount,
    'tenant_id', v_token.tenant_id, 'float_before', v_float_before, 'float_after', v_float_after, 'payment_method', p_payment_method);
end;
$f$;
