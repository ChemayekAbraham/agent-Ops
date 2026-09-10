CREATE OR REPLACE FUNCTION public.approve_promissory_note(p_note_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_note record;
  v_actor uuid := auth.uid();
  v_amount numeric;
  v_idempotency_key text;
  v_group_id uuid;
  v_ids uuid[];
  v_intent_total numeric := 0;
  v_available numeric := 0;
  v_commit jsonb := null;
  v_is_pso boolean := false;
begin
  if v_actor is null then
    return jsonb_build_object('status','error','message','Not authenticated');
  end if;
  if not exists (
    select 1 from public.user_roles ur
     where ur.user_id = v_actor
       and ur.role = any (array['operations','cfo','coo','super_admin','manager','partner_ops','ceo']::app_role[])
  ) then
    return jsonb_build_object('status','error','message','Not authorised to approve promissory notes');
  end if;
  if p_reason is null or length(btrim(p_reason)) < 20 then
    return jsonb_build_object('status','error','message','A reason of at least 20 characters is required.');
  end if;

  select * into v_note from public.promissory_notes where id = p_note_id for update;
  if not found then
    return jsonb_build_object('status','error','message','Promissory note not found');
  end if;
  if v_note.approval_bonus_paid then
    return jsonb_build_object('status','already_approved');
  end if;

  -- ── Attached tenant plans: the partner's own money funds them now ─────────
  select array_agg(rent_request_id), coalesce(sum(amount),0)
    into v_ids, v_intent_total
  from public.promissory_note_plan_intents
   where note_id = p_note_id and status = 'reserved';

  if v_ids is not null and array_length(v_ids,1) > 0 then
    if v_note.partner_user_id is null then
      return jsonb_build_object('status','error','message',
        'PARTNER_NOT_REGISTERED: this note has tenant plans attached. The partner must register and deposit their funds before it can be approved.');
    end if;

    v_available := public.get_user_available_balance(v_note.partner_user_id);
    if v_intent_total > v_available then
      return jsonb_build_object('status','error','message',
        'PARTNER_FUNDS_SHORT: attached plans total UGX ' || to_char(round(v_intent_total),'FM999,999,999') ||
        ' but the partner has only UGX ' || to_char(round(greatest(v_available,0)),'FM999,999,999') ||
        ' available in their withdrawable wallet.');
    end if;

    begin
      v_commit := public.psm_confirm_commitment_for(
        v_note.partner_user_id, v_ids, 12, 'pnote-' || p_note_id::text, v_actor, p_note_id);
    exception when others then
      return jsonb_build_object('status','error','message', sqlerrm);
    end;

    update public.promissory_note_plan_intents
       set status = 'funded',
           commitment_id = (v_commit->>'commitment_id')::uuid,
           updated_at = now()
     where note_id = p_note_id and status = 'reserved';
  end if;

  -- ── Platform Sales Officers earn no promissory note verification bonus ────
  select exists (
    select 1 from public.v_pso_officers o where o.user_id = v_note.agent_id
  ) into v_is_pso;

  if v_is_pso then
    v_amount := 0;
  else
    v_amount := public.partner_note_rate('agent', now());
    if v_amount is null or v_amount <= 0 then
      return jsonb_build_object('status','error','message','No agent bonus rate in force');
    end if;

    v_idempotency_key := 'promissory_note_verified:' || p_note_id::text;

    v_group_id := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id',v_note.agent_id,'amount',v_amount,
          'direction','cash_out','category','marketing_expense',
          'source_table','promissory_notes','source_id',p_note_id::text,
          'description','Marketing expense: Verified promissory note bonus',
          'ledger_scope','platform'),
        jsonb_build_object('user_id',v_note.agent_id,'amount',v_amount,
          'direction','cash_in','category','agent_commission',
          'source_table','promissory_notes','source_id',p_note_id::text,
          'description','Bonus: Verified promissory note',
          'ledger_scope','wallet','recipient_type','user')),
      v_idempotency_key);
  end if;

  update public.promissory_notes
     set approved_at = now(), approved_by = v_actor,
         approval_reason = btrim(p_reason), approval_bonus_paid = true,
         status = case when status = 'pending' then 'activated' else status end,
         updated_at = now()
   where id = p_note_id;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  values (v_actor,'update','approve_promissory_note','promissory_notes',p_note_id::text,
    jsonb_build_object('reason',btrim(p_reason),'agent_id',v_note.agent_id,
      'partner_name',v_note.partner_name,'bonus_amount',v_amount,
      'ledger_group_id',v_group_id,
      'pso_bonus_excluded', v_is_pso,
      'attached_plans', coalesce(array_length(v_ids,1),0),
      'attached_amount', v_intent_total,
      'deployment_mode', case when coalesce(array_length(v_ids,1),0) > 0 then 'self_managed' else 'none' end,
      'commitment', v_commit));

  begin
    if v_is_pso then
      insert into public.notifications (user_id, title, message, type, metadata)
      values (v_note.agent_id,
        'Promissory note verified',
        'Your promissory note for ' || v_note.partner_name ||
        ' was verified. Platform Sales Officer notes carry no verification reward.',
        'success',
        jsonb_build_object('source_id',p_note_id,'amount',0,'pso_bonus_excluded',true));
    else
      insert into public.notifications (user_id, title, message, type, metadata)
      values (v_note.agent_id,
        'Reward earned: UGX ' || to_char(v_amount,'FM999,999,999'),
        'Your promissory note for ' || v_note.partner_name ||
        ' was verified — UGX ' || to_char(v_amount,'FM999,999,999') ||
        ' has been added to your wallet.',
        'success',
        jsonb_build_object('source_id',p_note_id,'amount',v_amount,'ledger_group_id',v_group_id));
    end if;
  exception when others then
    raise warning 'approve_promissory_note notification failed for %: %', p_note_id, sqlerrm;
  end;

  return jsonb_build_object('status','approved','amount',v_amount,'ledger_group_id',v_group_id,
                            'pso_bonus_excluded', v_is_pso,
                            'funded_plans', coalesce(array_length(v_ids,1),0),
                            'funded_amount', v_intent_total,
                            'commitment', v_commit);
end;
$function$;