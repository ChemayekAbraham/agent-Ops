create table public.wh_landlord_portfolio_verifications (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null,
  landlord_phone_key text not null,
  landlord_phone_sent text not null,
  landlord_name text,
  subscription_ids uuid[] not null,
  tenant_count int not null,
  total_monthly_rent numeric not null default 0,
  verified_by uuid not null,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
grant select on public.wh_landlord_portfolio_verifications to authenticated;
grant all on public.wh_landlord_portfolio_verifications to service_role;
alter table public.wh_landlord_portfolio_verifications enable row level security;
create policy wh_lpv_read on public.wh_landlord_portfolio_verifications for select to authenticated
  using (agent_id = (select auth.uid())
    or (select public.has_role((select auth.uid()), 'agent_ops'::app_role))
    or (select public.has_role((select auth.uid()), 'coo'::app_role))
    or (select public.has_role((select auth.uid()), 'cfo'::app_role))
    or (select public.has_role((select auth.uid()), 'manager'::app_role))
    or (select public.has_role((select auth.uid()), 'super_admin'::app_role)));
create policy mfa_required_for_staff on public.wh_landlord_portfolio_verifications as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
create index wh_lpv_agent_key_idx on public.wh_landlord_portfolio_verifications (agent_id, landlord_phone_key, verified_at desc);

create or replace function public._wh_lpv_append_only() returns trigger language plpgsql set search_path = public as $$
begin raise exception 'Landlord verification records cannot be changed or deleted'; end $$;
create trigger trg_wh_lpv_append_only before update or delete on public.wh_landlord_portfolio_verifications
  for each row execute function public._wh_lpv_append_only();

create or replace function public._wh_phone_key(p text) returns text language sql immutable set search_path = public as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 9), '')
$$;

-- Current portfolio: the agent's active, unfunded agent-collection plans under this landlord phone.
create or replace function public._wh_portfolio_subs(p_agent uuid, p_key text) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(s.id order by s.id), '{}'::uuid[])
    from public.welile_homes_subscriptions s
   where s.agent_id = p_agent and s.subscription_status = 'active'
     and s.mode = 'agent_collection' and s.funding_status = 'unfunded'
     and public._wh_phone_key(s.landlord_phone) = p_key
$$;
revoke all on function public._wh_portfolio_subs(uuid, text) from public, anon, authenticated;

-- Same ownership rule as wh_request_float: not a landlord registered only by another agent.
create or replace function public._wh_owns_landlord_key(p_agent uuid, p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.landlords l where public._wh_phone_key(l.phone) = p_key and l.registered_by = p_agent)
      or not exists (select 1 from public.landlords l where public._wh_phone_key(l.phone) = p_key and l.registered_by is distinct from p_agent)
$$;
revoke all on function public._wh_owns_landlord_key(uuid, text) from public, anon, authenticated;

create or replace function public.wh_portfolio_verify_landlord(p_landlord_phone text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_key text := public._wh_phone_key(p_landlord_phone);
  v_subs uuid[];
  v_check jsonb;
  v_name text; v_phone text; v_total numeric;
begin
  if v_uid is null then return jsonb_build_object('success', false, 'error', 'Please sign in again'); end if;
  if v_key is null or length(v_key) < 9 then return jsonb_build_object('success', false, 'error', 'This landlord has no valid phone number on file'); end if;
  if coalesce(p_code, '') !~ '^\d{6}$' then return jsonb_build_object('success', false, 'error', 'Enter the 6-digit code'); end if;
  v_subs := public._wh_portfolio_subs(v_uid, v_key);
  if cardinality(v_subs) = 0 then return jsonb_build_object('success', false, 'error', 'No tenants are waiting for verification under this landlord'); end if;
  if not public._wh_owns_landlord_key(v_uid, v_key) then
    return jsonb_build_object('success', false, 'error', 'You can only verify landlords you registered');
  end if;

  v_check := public.otp_check_code(v_key, p_code);
  case v_check->>'result'
    when 'verified' then null;
    when 'wrong' then return jsonb_build_object('success', false, 'error', format('Wrong code. %s attempts remaining.', v_check->>'remaining'), 'remaining', (v_check->>'remaining')::int);
    when 'expired' then return jsonb_build_object('success', false, 'error', 'This code has expired. Tap Resend code.', 'expired', true);
    when 'locked' then return jsonb_build_object('success', false, 'error', 'Too many wrong attempts. Tap Resend code for a new one.', 'locked', true);
    else return jsonb_build_object('success', false, 'error', 'No active code for this landlord. Tap Resend code.', 'expired', true);
  end case;

  select max(s.landlord_name), max(s.landlord_phone), coalesce(sum(s.monthly_rent), 0)
    into v_name, v_phone, v_total
    from public.welile_homes_subscriptions s where s.id = any(v_subs);

  insert into public.wh_landlord_portfolio_verifications
    (agent_id, landlord_phone_key, landlord_phone_sent, landlord_name, subscription_ids, tenant_count, total_monthly_rent, verified_by)
  values (v_uid, v_key, coalesce(v_phone, p_landlord_phone), v_name, v_subs, cardinality(v_subs), v_total, v_uid);

  return jsonb_build_object('success', true, 'tenant_count', cardinality(v_subs), 'total_monthly_rent', v_total);
end $$;
revoke all on function public.wh_portfolio_verify_landlord(text, text) from public, anon;
grant execute on function public.wh_portfolio_verify_landlord(text, text) to authenticated;

-- Per-landlord verification state for the calling agent.
create or replace function public.wh_my_portfolio_status()
returns table(landlord_phone_key text, verified boolean, verified_at timestamptz, phone_sent text, current_count int)
language sql stable security definer set search_path = public as $$
  with keys as (
    select distinct public._wh_phone_key(s.landlord_phone) k
      from public.welile_homes_subscriptions s
     where s.agent_id = (select auth.uid()) and public._wh_phone_key(s.landlord_phone) is not null
  ), cur as (
    select k, public._wh_portfolio_subs((select auth.uid()), k) subs from keys
  ), last as (
    select distinct on (v.landlord_phone_key) v.landlord_phone_key k, v.subscription_ids, v.verified_at, v.landlord_phone_sent
      from public.wh_landlord_portfolio_verifications v
     where v.agent_id = (select auth.uid())
     order by v.landlord_phone_key, v.verified_at desc
  )
  select c.k, (l.k is not null and cardinality(c.subs) > 0 and l.subscription_ids = c.subs), l.verified_at, l.landlord_phone_sent, cardinality(c.subs)
    from cur c left join last l on l.k = c.k
$$;
revoke all on function public.wh_my_portfolio_status() from public, anon;
grant execute on function public.wh_my_portfolio_status() to authenticated;

CREATE OR REPLACE FUNCTION public.wh_request_float(p_subscription_ids uuid[], p_recipient_phone text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_found int;
  v_total numeric;
  v_bad int;
  v_req uuid;
  v_key record;
  v_cur uuid[];
  v_ver uuid[];
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select array_agg(distinct x) into v_ids from unnest(p_subscription_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) = 0 then
    raise exception 'Select at least one tenant' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 200 then
    raise exception 'At most 200 tenants per request' using errcode = '22023';
  end if;

  perform 1 from public.welile_homes_subscriptions s where s.id = any(v_ids) for update;

  select count(*) into v_found from public.welile_homes_subscriptions s
   where s.id = any(v_ids) and s.agent_id = v_uid and s.subscription_status = 'active'
     and s.mode = 'agent_collection' and s.funding_status = 'unfunded';
  if v_found <> cardinality(v_ids) then
    raise exception 'Some tenants are not yours, not active, or already have a float request' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.welile_homes_subscriptions s
     where s.id = any(v_ids)
       and ((s.landlord_id is not null and not exists (
               select 1 from public.landlords l where l.id = s.landlord_id and l.registered_by = v_uid))
         or (s.landlord_id is null and nullif(trim(s.landlord_phone), '') is not null
             and exists (select 1 from public.landlords l where l.phone = trim(s.landlord_phone) and l.registered_by is distinct from v_uid)
             and not exists (select 1 from public.landlords l where l.phone = trim(s.landlord_phone) and l.registered_by = v_uid)))
  ) then
    raise exception 'Float can only be requested for landlords you registered' using errcode = '42501';
  end if;

  -- Landlord OTP per portfolio: the landlord must have confirmed, by SMS code, the exact current
  -- tenant list, and the request must cover that whole list. Tenants are never verified.
  if exists (select 1 from public.welile_homes_subscriptions s where s.id = any(v_ids) and public._wh_phone_key(s.landlord_phone) is null) then
    raise exception 'Add the landlord phone number before requesting float' using errcode = '22023';
  end if;
  for v_key in select distinct public._wh_phone_key(s.landlord_phone) k from public.welile_homes_subscriptions s where s.id = any(v_ids) loop
    if not public._wh_owns_landlord_key(v_uid, v_key.k) then
      raise exception 'Float can only be requested for landlords you registered' using errcode = '42501';
    end if;
    v_cur := public._wh_portfolio_subs(v_uid, v_key.k);
    select v.subscription_ids into v_ver from public.wh_landlord_portfolio_verifications v
     where v.agent_id = v_uid and v.landlord_phone_key = v_key.k order by v.verified_at desc limit 1;
    if v_ver is null or v_ver is distinct from v_cur then
      raise exception 'Verify the landlord by SMS code for the current tenant list before requesting float' using errcode = '42501';
    end if;
    if exists (select 1 from unnest(v_cur) c where not (c = any(v_ids))) then
      raise exception 'Include every tenant in the verified landlord portfolio' using errcode = '22023';
    end if;
  end loop;

  select count(*) filter (where amt is null or amt <= 0), coalesce(sum(amt) filter (where amt > 0), 0)
    into v_bad, v_total
    from (select s.id, (select d.amount_due - coalesce(d.amount_collected, 0)
                          from public.welile_homes_monthly_dues d
                         where d.subscription_id = s.id and d.collection_status <> 'collected'
                         order by d.due_month_index limit 1) amt
            from public.welile_homes_subscriptions s where s.id = any(v_ids)) x;
  if v_bad > 0 or v_total <= 0 then
    raise exception 'Some tenants have no unpaid monthly due to fund' using errcode = '22023';
  end if;

  perform set_config('welile.wh_float_rpc', 'on', true);

  insert into public.float_requests (agent_id, requested_amount, reason, expected_recipient_phone, status, product)
  values (v_uid, v_total,
    format('Welile Homes landlord float (%s tenants)', cardinality(v_ids)) || coalesce(': ' || nullif(trim(p_notes), ''), ''),
    nullif(trim(p_recipient_phone), ''), 'pending', 'welile_homes')
  returning id into v_req;

  insert into public.welile_homes_float_request_items (float_request_id, subscription_id, amount)
  select v_req, s.id, (select d.amount_due - coalesce(d.amount_collected, 0)
                         from public.welile_homes_monthly_dues d
                        where d.subscription_id = s.id and d.collection_status <> 'collected'
                        order by d.due_month_index limit 1)
    from public.welile_homes_subscriptions s where s.id = any(v_ids);

  update public.welile_homes_subscriptions set funding_status = 'requested', updated_at = now() where id = any(v_ids);

  return jsonb_build_object('success', true, 'request_id', v_req, 'amount', v_total, 'tenant_count', cardinality(v_ids));
end $function$;