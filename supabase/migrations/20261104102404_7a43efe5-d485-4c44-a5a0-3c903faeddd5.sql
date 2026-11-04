-- 1. Append-only stage history for Welile Homes float requests
create table public.wh_float_request_events (
  id uuid primary key default gen_random_uuid(),
  float_request_id uuid not null references public.float_requests(id),
  from_status text,
  to_status text not null,
  action text not null,
  stage text,
  actor_id uuid,
  note text,
  created_at timestamptz not null default now()
);
grant all on public.wh_float_request_events to service_role;
alter table public.wh_float_request_events enable row level security;
create policy mfa_required_for_staff on public.wh_float_request_events as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
create index wh_float_request_events_req_idx on public.wh_float_request_events(float_request_id, created_at);

create or replace function public._wh_float_events_append_only() returns trigger
language plpgsql set search_path = public as $$
begin raise exception 'Welile Homes float history is append-only' using errcode = '42501'; end $$;
create trigger trg_wh_float_events_append_only before update or delete on public.wh_float_request_events
  for each row execute function public._wh_float_events_append_only();

create or replace function public._wh_float_stage_of(p_status text) returns text
language sql immutable set search_path = public as $$
  select case p_status
    when 'pending' then 'agent_ops'
    when 'agent_ops_approved' then 'tenant_ops'
    when 'tenant_ops_approved' then 'landlord_ops'
    when 'landlord_ops_approved' then 'coo'
    when 'coo_approved' then 'cfo'
    else null end $$;

create or replace function public._wh_float_log_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_action text;
begin
  if coalesce(new.product,'') <> 'welile_homes' then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.wh_float_request_events(float_request_id, from_status, to_status, action, stage, actor_id, note)
    values (new.id, null, new.status, 'submitted', 'agent', coalesce(auth.uid(), new.agent_id), null);
    return new;
  end if;
  if new.status is not distinct from old.status then return new; end if;
  v_action := case new.status
    when 'rejected' then 'rejected'
    when 'returned_to_agent' then 'returned'
    when 'approved' then 'disbursed'
    else 'approved' end;
  insert into public.wh_float_request_events(float_request_id, from_status, to_status, action, stage, actor_id, note)
  values (new.id, old.status, new.status, v_action, public._wh_float_stage_of(old.status), auth.uid(),
          case when v_action in ('rejected','returned') then new.rejection_reason end);
  return new;
end $$;
create trigger trg_wh_float_log_event after insert or update of status on public.float_requests
  for each row execute function public._wh_float_log_event();

-- Backfill: every existing request gets its submission; existing rejections are recorded without an actor.
insert into public.wh_float_request_events(float_request_id, from_status, to_status, action, stage, actor_id, note, created_at)
select id, null, 'pending', 'submitted', 'agent', agent_id, null, created_at
from public.float_requests where product = 'welile_homes';
insert into public.wh_float_request_events(float_request_id, from_status, to_status, action, stage, actor_id, note, created_at)
select id, null, status, case status when 'rejected' then 'rejected' when 'approved' then 'disbursed' else 'approved' end,
       null, null, rejection_reason, coalesce(updated_at, created_at)
from public.float_requests where product = 'welile_homes' and status <> 'pending';

-- 2. Stage chain: Agent Ops -> Tenant Ops -> Landlord Ops -> COO -> CFO (disburse only via wh_cfo_disburse_float)
create or replace function public.wh_float_advance(p_request_id uuid, p_expected_status text, p_action text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
  v_uid uuid := auth.uid();
  v_req public.float_requests%rowtype;
  v_next text;
  v_role app_role;
  v_admin boolean;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_action not in ('approve','reject','return') then
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;

  select * into v_req from public.float_requests where id = p_request_id for update;
  if not found or v_req.product <> 'welile_homes' then
    raise exception 'Welile Homes float request not found' using errcode = '22023';
  end if;
  if v_req.status is distinct from p_expected_status then
    raise exception 'Request is now "%", not "%" - refresh and try again', v_req.status, p_expected_status using errcode = '40001';
  end if;

  v_admin := public.has_role(v_uid, 'super_admin');
  case v_req.status
    when 'pending' then v_role := 'agent_ops'; v_next := 'agent_ops_approved';
    when 'agent_ops_approved' then v_role := 'tenant_ops'; v_next := 'tenant_ops_approved';
    when 'tenant_ops_approved' then v_role := 'landlord_ops'; v_next := 'landlord_ops_approved';
    when 'landlord_ops_approved' then v_role := 'coo'; v_next := 'coo_approved';
    when 'coo_approved' then v_role := 'cfo'; v_next := null; -- CFO approves only by disbursing
    else raise exception 'Request in status "%" cannot change', v_req.status using errcode = '22023';
  end case;

  if not (v_admin or public.has_role(v_uid, v_role)) then
    raise exception 'Only % can act on a request at this stage', replace(v_role::text, '_', ' ') using errcode = '42501';
  end if;
  if p_action = 'reject' then v_next := 'rejected';
  elsif p_action = 'return' then v_next := 'returned_to_agent';
  elsif v_next is null then
    raise exception 'The CFO approves by disbursing; use the disbursement action' using errcode = '22023';
  end if;
  if p_action in ('reject','return') and length(trim(coalesce(p_note, ''))) < 5 then
    raise exception 'Add a reason of at least 5 characters' using errcode = '22023';
  end if;
  if p_action = 'approve' and not exists (
       select 1 from public.welile_homes_float_request_items i where i.float_request_id = p_request_id and i.released_at is null) then
    raise exception 'This request has no linked tenants (created before the new flow). Reject it with a note; the agent must request again.' using errcode = '22023';
  end if;

  perform set_config('welile.wh_float_rpc', 'on', true);
  update public.float_requests
     set status = v_next,
         rejection_reason = case when p_action in ('reject','return') then trim(p_note) else rejection_reason end,
         updated_at = now()
   where id = p_request_id;

  if v_next in ('rejected','returned_to_agent') then
    update public.welile_homes_subscriptions s set funding_status = 'unfunded', updated_at = now()
      from public.welile_homes_float_request_items i
     where i.float_request_id = p_request_id and i.released_at is null and s.id = i.subscription_id;
    update public.welile_homes_float_request_items set released_at = now()
     where float_request_id = p_request_id and released_at is null;
  end if;

  return jsonb_build_object('success', true, 'request_id', p_request_id, 'status', v_next);
end $function$;

-- 3. Review queue + history reads (role-gated; RLS on float_requests does not cover every review role)
create or replace function public._wh_float_reviewer(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role(p_uid,'agent_ops') or public.has_role(p_uid,'tenant_ops') or public.has_role(p_uid,'landlord_ops')
      or public.has_role(p_uid,'coo') or public.has_role(p_uid,'cfo') or public.has_role(p_uid,'super_admin')
      or public.has_role(p_uid,'manager') or public.has_role(p_uid,'operations') $$;

create or replace function public.wh_float_review_queue(p_limit int default 200)
returns table(id uuid, agent_id uuid, agent_name text, agent_phone text, requested_amount numeric, reason text,
              expected_recipient_phone text, status text, rejection_reason text, created_at timestamptz,
              updated_at timestamptz, tenant_count int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._wh_float_reviewer(auth.uid()) then
    raise exception 'Your role cannot view Welile Homes float reviews' using errcode = '42501';
  end if;
  return query
  select f.id, f.agent_id, p.full_name, p.phone, f.requested_amount, f.reason, f.expected_recipient_phone, f.status,
         f.rejection_reason, f.created_at, f.updated_at,
         (select count(*)::int from public.welile_homes_float_request_items i where i.float_request_id = f.id)
  from public.float_requests f left join public.profiles p on p.id = f.agent_id
  where f.product = 'welile_homes'
  order by f.created_at desc
  limit least(greatest(coalesce(p_limit,200),1),500);
end $$;

create or replace function public.wh_float_request_history(p_request_ids uuid[])
returns table(float_request_id uuid, from_status text, to_status text, action text, stage text,
              actor_id uuid, actor_name text, note text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_staff boolean;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  v_staff := public._wh_float_reviewer(v_uid);
  return query
  select e.float_request_id, e.from_status, e.to_status, e.action, e.stage, e.actor_id, p.full_name, e.note, e.created_at
  from public.wh_float_request_events e
  join public.float_requests f on f.id = e.float_request_id
  left join public.profiles p on p.id = e.actor_id
  where e.float_request_id = any(p_request_ids) and (v_staff or f.agent_id = v_uid)
  order by e.float_request_id, e.created_at;
end $$;

revoke all on function public.wh_float_review_queue(int) from public, anon;
revoke all on function public.wh_float_request_history(uuid[]) from public, anon;
revoke all on function public._wh_float_reviewer(uuid) from public, anon;
grant execute on function public.wh_float_review_queue(int) to authenticated;
grant execute on function public.wh_float_request_history(uuid[]) to authenticated;
grant execute on function public.wh_float_advance(uuid, text, text, text) to authenticated;