-- Tenant Ops engagement report: cross-references existing smartphone-ownership
-- (profiles.has_smartphone) and general app-activity (profiles.last_active_at)
-- signals so Tenant Ops can see who owns a smartphone but isn't using their
-- dashboard/app. Both source columns already exist and are already
-- maintained elsewhere (EditTenantDialog, useAuth's session heartbeat) —
-- this just adds the missing reporting layer.
create or replace function public.get_tenant_engagement_report(
  p_limit int default 200,
  p_offset int default 0,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
    or public.has_role(auth.uid(),'operations') or public.has_role(auth.uid(),'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  with tenants as (
    select distinct p.id, p.full_name, p.phone, p.has_smartphone, p.last_active_at, p.tenant_status
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.role = 'tenant' and ur.enabled
    where p.deleted_at is null
      and (
        p_search is null or p_search = ''
        or p.full_name ilike '%' || p_search || '%'
        or p.phone ilike '%' || p_search || '%'
      )
  ),
  enriched as (
    select t.*,
      case when t.last_active_at is null then null
           else greatest(0, extract(day from (now() - t.last_active_at))::int)
      end as days_since_active
    from tenants t
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'tenants', count(*),
      'with_smartphone', count(*) filter (where has_smartphone),
      'without_smartphone', count(*) filter (where not has_smartphone),
      'never_active', count(*) filter (where last_active_at is null),
      'inactive_30d', count(*) filter (where last_active_at is not null and last_active_at < now() - interval '30 days'),
      'generated_at', now()
    ),
    'rows', (
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      from (
        select id as tenant_id, full_name, phone, has_smartphone, last_active_at,
               tenant_status, days_since_active
        from enriched
        order by
          has_smartphone desc,
          (days_since_active is null) desc,
          days_since_active desc nulls first
        limit greatest(1, least(coalesce(p_limit, 200), 1000))
        offset greatest(0, coalesce(p_offset, 0))
      ) x
    )
  )
  into v_result
  from enriched;

  return coalesce(v_result, jsonb_build_object(
    'summary', jsonb_build_object(
      'tenants', 0, 'with_smartphone', 0, 'without_smartphone', 0,
      'never_active', 0, 'inactive_30d', 0, 'generated_at', now()
    ),
    'rows', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.get_tenant_engagement_report(int,int,text) from public;
grant execute on function public.get_tenant_engagement_report(int,int,text) to authenticated;
grant execute on function public.get_tenant_engagement_report(int,int,text) to service_role, postgres;
