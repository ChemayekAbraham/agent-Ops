-- Tenant Locations: multi-place selection and PDF export (read-only).
--
-- 1. tlb_tenants_multi: the tenants of SEVERAL selected places in one call.
--    Same caller check (tlb_authorized) and same source view (v_tlb_tenant_base)
--    and status filter as tlb_tenants. One row per tenant even when selected
--    places overlap: a tenant is credited to the MOST SPECIFIC selected place
--    that matches (a village beats its district), ties go to the lower index.
--    That makes per-place counts add up to the grand total.
-- 2. tlb_log_location_pdf_export: caller-checked, append-only audit row written
--    when a Tenant Location Report PDF (which contains phone numbers) is made.
--
-- Nothing here writes tenant, wallet, ledger or Rent Plan data. audit_logs is
-- already append-only (trg_audit_logs_no_update_delete / _no_truncate).

create or replace function public.tlb_tenants_multi(
  p_paths  jsonb,
  p_status text default 'all',
  p_limit  integer default 5000
)
returns table (
  tenant_id          uuid,
  tenant_name        text,
  tenant_phone       text,
  agent_id           uuid,
  agent_name         text,
  latest_status      text,
  is_active          boolean,
  depth              integer,
  region             text,
  district_name      text,
  county_name        text,
  subcounty_name     text,
  parish_name        text,
  village_name       text,
  legacy_location    text,
  matched_path_index integer,
  total_count        bigint
)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 5000), 5000));
  v_count integer;
begin
  -- Exactly the access check tlb_tenants uses.
  if not public.tlb_authorized() then
    raise exception 'not authorized';
  end if;

  if p_status is null or p_status not in ('all', 'active', 'inactive') then
    raise exception 'invalid status';
  end if;

  if p_paths is null or jsonb_typeof(p_paths) <> 'array' then
    raise exception 'p_paths must be a json array';
  end if;
  v_count := jsonb_array_length(p_paths);
  if v_count < 1 or v_count > 200 then
    raise exception 'select between 1 and 200 places';
  end if;

  return query
  with paths as (
    select
      (t.ord - 1)::integer                              as idx,
      nullif(btrim(t.e ->> 'region'), '')               as p_region,
      (t.e ->> 'district_id')::integer                  as p_district_id,
      (t.e ->> 'county_id')::integer                    as p_county_id,
      (t.e ->> 'subcounty_id')::integer                 as p_subcounty_id,
      (t.e ->> 'parish_id')::integer                    as p_parish_id,
      (t.e ->> 'village_id')::integer                   as p_village_id,
      coalesce((t.e ->> 'unmapped')::boolean, false)    as p_unmapped
    from jsonb_array_elements(p_paths) with ordinality as t(e, ord)
  ), specific as (
    select p.*,
           (case when p.p_region      is not null then 1 else 0 end)
         + (case when p.p_district_id  is not null then 1 else 0 end)
         + (case when p.p_county_id    is not null then 1 else 0 end)
         + (case when p.p_subcounty_id is not null then 1 else 0 end)
         + (case when p.p_parish_id    is not null then 1 else 0 end)
         + (case when p.p_village_id   is not null then 1 else 0 end)
         + (case when p.p_unmapped then 1 else 0 end)  as spec
    from paths p
  ), picked as (
    -- one row per tenant: the most specific matching selected place
    select distinct on (b.tenant_id) b.*, s.idx as matched_idx
    from public.v_tlb_tenant_base b
    join specific s
      on s.spec > 0
     and (not s.p_unmapped or b.district_id is null)
     and (s.p_region      is null or b.region = s.p_region)
     and (s.p_district_id  is null or b.district_id = s.p_district_id)
     and (s.p_county_id    is null or b.county_id = s.p_county_id)
     and (s.p_subcounty_id is null or b.subcounty_id = s.p_subcounty_id)
     and (s.p_parish_id    is null or b.parish_id = s.p_parish_id)
     and (s.p_village_id   is null or b.village_id = s.p_village_id)
    where (p_status = 'all'
           or (p_status = 'active' and b.is_active)
           or (p_status = 'inactive' and not b.is_active))
    order by b.tenant_id, s.spec desc, s.idx asc
  ), counted as (
    select k.*, count(*) over () as total_count from picked k
  )
  select c.tenant_id, c.tenant_name, c.tenant_phone, c.agent_id, c.agent_name,
         c.latest_status, c.is_active, c.depth, c.region, c.district_name,
         c.county_name, c.subcounty_name, c.parish_name, c.village_name,
         c.legacy_location, c.matched_idx, c.total_count
  from counted c
  order by c.matched_idx, c.tenant_name, c.tenant_id
  limit v_limit;
end;
$function$;

revoke all on function public.tlb_tenants_multi(jsonb, text, integer) from public, anon;
grant execute on function public.tlb_tenants_multi(jsonb, text, integer) to authenticated;
grant execute on function public.tlb_tenants_multi(jsonb, text, integer) to service_role;

comment on function public.tlb_tenants_multi(jsonb, text, integer) is
  'Read-only. Distinct tenants for several selected Tenant Location places (max 5000 rows). Same access check as tlb_tenants. Each tenant is credited to the most specific selected place, so per-place counts add up to total_count.';

-- ---------------------------------------------------------------------------
-- Audit: a PDF with personal phone numbers was generated.
-- ---------------------------------------------------------------------------
create or replace function public.tlb_log_location_pdf_export(
  p_reason       text,
  p_places       integer,
  p_tenants      integer,
  p_status       text,
  p_place_labels text[] default '{}'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null or not public.tlb_authorized() then
    raise exception 'not authorized';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'reason must be at least 10 characters';
  end if;
  if p_status is null or p_status not in ('all', 'active', 'inactive') then
    raise exception 'invalid status';
  end if;
  if coalesce(p_places, 0) < 1 or coalesce(p_tenants, -1) < 0 then
    raise exception 'invalid counts';
  end if;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  values (
    v_uid,
    'tenant_location_pdf_export',
    'v_tlb_tenant_base',
    null,
    left(btrim(p_reason), 500),
    jsonb_build_object(
      'places', p_places,
      'tenants', p_tenants,
      'status', p_status,
      'place_labels', to_jsonb(coalesce(p_place_labels[1:25], '{}'::text[])),
      'contains_phone_numbers', true
    )
  )
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.tlb_log_location_pdf_export(text, integer, integer, text, text[]) from public, anon;
grant execute on function public.tlb_log_location_pdf_export(text, integer, integer, text, text[]) to authenticated;
grant execute on function public.tlb_log_location_pdf_export(text, integer, integer, text, text[]) to service_role;

comment on function public.tlb_log_location_pdf_export(text, integer, integer, text, text[]) is
  'Append-only audit row (audit_logs) for a Tenant Location Report PDF. Caller must pass tlb_authorized(); reason >= 10 characters.';
