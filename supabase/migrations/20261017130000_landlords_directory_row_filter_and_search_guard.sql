-- 2026-10-17 (doc 247): landlords_directory (owner-rights view over landlords) and its search RPC were readable by everyone.
-- Found: any signed-in user (supporters, tenants) could read all 46,743 landlords incl. phone, GPS, meter numbers and
-- caretaker phone through the view, and `anon` (signed out) could pull them through search_landlords_fuzzy (executable by PUBLIC).
-- Fix (already applied to production 2026-10-17; this keeps rebuilds consistent):
--  1) search_landlords_fuzzy: execute revoked from PUBLIC/anon, granted to authenticated + service_role only.
--  2) landlords_directory: same columns, now filtered. Visible rows: service role / direct SQL (no JWT role), any user holding a
--     role other than tenant/landlord/supporter (agents and staff), or the user's own landlord (registered_by,
--     managed_by_agent_id, tenant_id, or profiles.borrower_landlord_id).
--  3) search_landlords_fuzzy reads public.landlords directly (so tenants/borrowers can still find THEIR landlord to link it) but
--     non-privileged callers need a query of 3+ characters and get at most 10 rows; agents/staff keep the old behaviour (<=100).
-- Tested as supporter / tenant / agent / CFO / borrower with a linked landlord: agents and staff unchanged (46,743 view rows;
-- search 100/100/32), supporters and tenants 0 view rows, linked borrower exactly 1.
revoke execute on function public.search_landlords_fuzzy(text, integer, real, uuid) from public, anon;
grant execute on function public.search_landlords_fuzzy(text, integer, real, uuid) to authenticated, service_role;

create or replace view public.landlords_directory as
 select id, name, phone, property_address, description, latitude, longitude, location_captured_at, monthly_rent, desired_rent_from_welile, number_of_rooms, number_of_houses, house_category, house_number, verified, verified_at, verification_status, verification_reason, ready_to_receive, has_smartphone, is_occupied, is_agent_managed, managed_by_agent_id, registered_by, tenant_id, electricity_meter_number, water_meter_number, caretaker_name, caretaker_phone, country, region, district, county, sub_county, town_council, village, cell, created_at, updated_at
   from public.landlords
  where coalesce(auth.role(), 'service_role') = 'service_role'
     or exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role::text <> all (array['tenant','landlord','supporter']))
     or registered_by = auth.uid()
     or managed_by_agent_id = auth.uid()
     or tenant_id = auth.uid()
     or id = (select p.borrower_landlord_id from public.profiles p where p.id = auth.uid());

create or replace function public.search_landlords_fuzzy(p_query text default ''::text, p_limit integer default 20, p_threshold real default 0.2, p_registered_by uuid default null::uuid)
 returns table(id uuid, name text, phone text, property_address text, district text, town_council text, county text, village text, house_category text, monthly_rent numeric, latitude numeric, longitude numeric, verified boolean, match_score real, match_kind text)
 language sql stable security definer set search_path to 'public'
as $function$
  with me as (
    select (coalesce(auth.role(), 'service_role') = 'service_role'
            or exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role::text <> all (array['tenant','landlord','supporter']))) as privileged
  ),
  q as (
    select trim(coalesce(p_query, '')) as raw,
           lower(trim(coalesce(p_query, ''))) as lc,
           regexp_replace(coalesce(p_query, ''), '\D', '', 'g') as digits
  ),
  base as (
    select l.*,
      case
        when (select raw from q) = '' then 1.0
        when lower(l.name) = (select lc from q) then 1.0
        when (select digits from q) <> '' and l.phone ilike '%' || (select digits from q) || '%' then 0.95
        when l.name ilike '%' || (select raw from q) || '%' then 0.9
        else similarity(lower(l.name), (select lc from q))
      end::real as score,
      case
        when (select raw from q) = '' then 'all'
        when lower(l.name) = (select lc from q) then 'name_exact'
        when (select digits from q) <> '' and l.phone ilike '%' || (select digits from q) || '%' then 'phone'
        when l.name ilike '%' || (select raw from q) || '%' then 'name_exact'
        else 'fuzzy'
      end as kind
    from public.landlords l
    where p_registered_by is null
       or l.registered_by = p_registered_by
       or l.managed_by_agent_id = p_registered_by
       -- An agent actively assigned to this landlord (e.g. paying them out for a different tenant/rent request)
       -- legitimately works with them, even when a colleague originally registered the record. Without this, an
       -- agent could pay a landlord's float but never find that same landlord again when posting a new tenant for
       -- them. See handover incident doc for the confirmed case (agent Shakirah Nakimbugwe / landlord
       -- "kayemba sharif", registered by a different agent, 2026-09-13).
       or exists (
         select 1 from public.agent_landlord_assignments a
         where a.landlord_id = l.id and a.agent_id = p_registered_by and a.status = 'active'
       )
  )
  select b.id, b.name, b.phone, b.property_address,
    b.district, b.town_council, b.county, b.village,
    b.house_category, b.monthly_rent, b.latitude, b.longitude,
    coalesce(b.verified, false) as verified,
    b.score as match_score, b.kind as match_kind
  from base b
  where ((select raw from q) = '' or b.score >= p_threshold)
    and ((select privileged from me) or length((select raw from q)) >= 3)
  order by coalesce(b.verified, false) desc, b.score desc, b.name asc
  limit least(greatest(p_limit, 1), case when (select privileged from me) then 100 else 10 end);
$function$;
