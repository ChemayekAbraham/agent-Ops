alter table public.welile_homes_subscriptions
  add column if not exists landlord_ref_id uuid references public.landlords(id) on delete restrict;
create index if not exists wh_subs_landlord_ref_idx on public.welile_homes_subscriptions (landlord_ref_id);

create or replace function public._wh_resolve_landlord_ref(p_landlord_id uuid, p_phone text, p_agent uuid)
returns uuid language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select l.id from public.landlords l where l.id = p_landlord_id),
    (select min(l.id::text)::uuid from public.landlords l
      where nullif(trim(p_phone), '') is not null and l.phone = trim(p_phone) and l.registered_by = p_agent
     having count(*) = 1));
$$;
revoke all on function public._wh_resolve_landlord_ref(uuid, text, uuid) from public, anon, authenticated;

update public.welile_homes_subscriptions s
   set landlord_ref_id = public._wh_resolve_landlord_ref(s.landlord_id, s.landlord_phone, s.agent_id)
 where s.landlord_ref_id is null;

create or replace function public._wh_set_landlord_ref()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.landlord_ref_id is null
     or (tg_op = 'UPDATE' and new.landlord_phone is distinct from old.landlord_phone and new.landlord_ref_id = old.landlord_ref_id) then
    new.landlord_ref_id := public._wh_resolve_landlord_ref(new.landlord_id, new.landlord_phone, new.agent_id);
  end if;
  return new;
end;
$$;
revoke all on function public._wh_set_landlord_ref() from public, anon, authenticated;
drop trigger if exists trg_wh_set_landlord_ref on public.welile_homes_subscriptions;
create trigger trg_wh_set_landlord_ref before insert or update of landlord_id, landlord_phone, agent_id, landlord_ref_id
  on public.welile_homes_subscriptions for each row execute function public._wh_set_landlord_ref();

-- Read-only pre-check used by the screen before showing the delete confirmation.
create or replace function public.wh_landlord_delete_blockers(p_landlord_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_l public.landlords%rowtype; v_reasons text[] := '{}'; v_drafts int;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select * into v_l from public.landlords where id = p_landlord_id;
  if not found then raise exception 'Landlord not found' using errcode = '22023'; end if;
  if not (coalesce(v_l.registered_by = v_uid, false) or coalesce(v_l.managed_by_agent_id = v_uid, false)
          or public.has_role(v_uid, 'manager')) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if exists (select 1 from public.welile_homes_subscriptions s join public.welile_homes_monthly_dues d on d.subscription_id = s.id
              where s.landlord_ref_id = p_landlord_id
                and (coalesce(d.amount_collected,0) > 0 or d.collection_status <> 'pending'
                     or coalesce(d.payout_status,'unpaid') <> 'unpaid' or d.ledger_transaction_id is not null)) then
    v_reasons := v_reasons || 'Tenant rent collections or landlord payouts are recorded';
  end if;
  if exists (select 1 from public.welile_homes_subscriptions s where s.landlord_ref_id = p_landlord_id
              and coalesce(s.receivable_total,0) > 0 and coalesce(s.outstanding_balance,0) < s.receivable_total) then
    v_reasons := v_reasons || 'A tenant plan balance has already been reduced';
  end if;
  if exists (select 1 from public.welile_homes_subscriptions s where s.landlord_ref_id = p_landlord_id
              and s.funding_status in ('requested','funded')) then
    v_reasons := v_reasons || 'Float is requested or funded for a tenant';
  end if;
  if exists (select 1 from public.welile_homes_subscriptions s join public.welile_homes_float_request_items i on i.subscription_id = s.id
              where s.landlord_ref_id = p_landlord_id) then
    v_reasons := v_reasons || 'A tenant is attached to a float request';
  end if;
  if exists (select 1 from public.rent_requests r where r.landlord_id = p_landlord_id
              and r.status not in ('rejected','cancelled','deleted_by_agent')) then
    v_reasons := v_reasons || 'The landlord has rent requests that are approved or in progress';
  end if;

  select count(*) into v_drafts from public.welile_homes_subscriptions where landlord_ref_id = p_landlord_id;
  return jsonb_build_object('deletable', cardinality(v_reasons) = 0, 'reasons', to_jsonb(v_reasons), 'draft_plans', v_drafts);
end;
$$;

create or replace function public.delete_welile_homes_landlord(p_landlord_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_check jsonb; v_sub record; v_n int := 0;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  perform 1 from public.landlords where id = p_landlord_id for update;
  if not found then raise exception 'Landlord not found' using errcode = '22023'; end if;
  perform 1 from public.welile_homes_subscriptions where landlord_ref_id = p_landlord_id for update;

  v_check := public.wh_landlord_delete_blockers(p_landlord_id);
  if not (v_check->>'deletable')::boolean then
    raise exception 'LANDLORD_NOT_DELETABLE: %', array_to_string(array(select jsonb_array_elements_text(v_check->'reasons')), '; ')
      using errcode = '42501';
  end if;

  -- Each plan goes through the plan guard; any refusal aborts the whole deletion.
  for v_sub in select id from public.welile_homes_subscriptions where landlord_ref_id = p_landlord_id loop
    perform public.delete_welile_home_subscription(v_sub.id);
    v_n := v_n + 1;
  end loop;

  delete from public.landlords where id = p_landlord_id;

  begin
    insert into public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    values ('user_deleted', v_uid, 'landlord', p_landlord_id, jsonb_build_object('action','delete_welile_homes_landlord','plans_removed',v_n));
  exception when others then null; end;

  return jsonb_build_object('success', true, 'plans_removed', v_n);
end;
$$;

revoke all on function public.wh_landlord_delete_blockers(uuid) from public, anon;
revoke all on function public.delete_welile_homes_landlord(uuid) from public, anon;
grant execute on function public.wh_landlord_delete_blockers(uuid) to authenticated, service_role;
grant execute on function public.delete_welile_homes_landlord(uuid) to authenticated, service_role;