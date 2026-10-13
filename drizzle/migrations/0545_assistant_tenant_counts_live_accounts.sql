-- Agent assistant: make the tenant COUNTS agree with the tenant LIST.
--
-- find_tenants / get_tenant_detail only show tenants whose profile still exists (a deleted
-- profile has no name or phone to show, and the service center skips them too), but
-- assistant_agent_tenants() counted every linked tenant id, so "how many tenants do I have?"
-- said 8 while the list showed 4 (the other 4 had deleted accounts).
--
-- The counts now use live accounts only, and `removed_accounts` reports how many linked tenants
-- have a deleted account, so the assistant can explain the difference instead of guessing.
-- tenants_billed_today is intentionally left on the pinned daily bill: it describes what the day's
-- expected figure was built from, and must keep adding up with that figure.

create or replace function public.assistant_agent_tenants()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  with linked_all as (
    select rr.tenant_id from public.rent_requests rr
     where rr.tenant_id is not null and rr.status <> 'deleted_by_agent'
       and (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
    union
    select ac.tenant_id from public.agent_collections ac
     where ac.tenant_id is not null and ac.agent_id = v_uid
       and ac.reversed_at is null and ac.amount > 0
  ),
  linked as (
    select la.tenant_id
      from linked_all la
      join public.profiles p on p.id = la.tenant_id and p.deleted_at is null
  ),
  active_plans as (
    select rr.id, rr.tenant_id
      from public.rent_requests rr
      join public.profiles p on p.id = rr.tenant_id and p.deleted_at is null
     where (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
       and rr.tenant_id is not null
       and rr.status in ('funded', 'repaying', 'disbursed', 'active')
       and coalesce(rr.tenancy_status, 'active') <> 'ended'
  )
  select jsonb_build_object(
    'tenants_linked',          (select count(*) from linked),
    'removed_accounts',        (select count(*) from linked_all) - (select count(*) from linked),
    'active_rent_plans',       (select count(*) from active_plans),
    'tenants_on_active_plans', (select count(distinct tenant_id) from active_plans),
    'tenants_billed_today',    (select count(distinct pl.tenant_id)
                                  from public.agent_expected_day_plans pl
                                 where pl.agent_id = v_uid and pl.day = v_today)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.assistant_agent_tenants() from public, anon;
grant  execute on function public.assistant_agent_tenants() to authenticated, service_role;