-- 2026-10-19 (doc 247, step 24): checked replacements for direct reads of the owner-rights view landlords_directory.
-- landlord_directory_entry(p_id): one landlord, only for staff, the registering / managing agent, the borrower whose profile links it, an agent who owns a listing or plan
--   for it, or a tenant on a plan with it. Replaces the by-id reads in EditHouseListingDialog, BorrowerResidenceGate and BorrowLoanSheet.
-- landlord_directory_browse(p_limit): the Rental Finder list (agents and staff only, capped at 2,000 rows, only the columns that screen uses).
-- Additive: nothing changes until the screens switch. After they ship, close the view to signed-in users (see doc 247 step 24) so the advisor flag disappears.
-- Already applied to production 2026-10-19.
create or replace function public.landlord_directory_entry(p_id uuid)
 returns setof public.landlords_directory
 language plpgsql stable security definer set search_path = public
as $f$
declare v_uid uuid := auth.uid();
begin
  if p_id is null then return; end if;
  if coalesce(auth.role(), 'service_role') <> 'service_role' and v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  return query
    select d.* from public.landlords_directory d
     where d.id = p_id
       and ( public.can_view_staff_reports(v_uid)
          or d.registered_by = v_uid
          or d.managed_by_agent_id = v_uid
          or exists (select 1 from public.profiles pr where pr.id = v_uid and pr.borrower_landlord_id = p_id)
          or exists (select 1 from public.house_listings hl where hl.landlord_id = p_id and hl.agent_id = v_uid)
          or exists (select 1 from public.rent_requests rr where rr.landlord_id = p_id and (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid or rr.tenant_id = v_uid)) );
end $f$;
revoke all on function public.landlord_directory_entry(uuid) from public, anon;
grant execute on function public.landlord_directory_entry(uuid) to authenticated, service_role;

create or replace function public.landlord_directory_browse(p_limit integer default 2000)
 returns table (id uuid, name text, phone text, property_address text, latitude numeric, longitude numeric, monthly_rent numeric, number_of_rooms integer, number_of_houses integer, verified boolean, country text, region text, district text, county text, sub_county text, town_council text, village text, cell text, house_number text, electricity_meter_number text, water_meter_number text, caretaker_name text, caretaker_phone text)
 language plpgsql stable security definer set search_path = public
as $f$
declare v_uid uuid := auth.uid();
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if not (public.can_view_staff_reports(v_uid)
            or exists (select 1 from public.user_roles ur where ur.user_id = v_uid and ur.enabled = true and ur.role::text = 'agent')) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;
  return query
    select d.id, d.name, d.phone, d.property_address, d.latitude, d.longitude, d.monthly_rent, d.number_of_rooms, d.number_of_houses, d.verified,
           d.country, d.region, d.district, d.county, d.sub_county, d.town_council, d.village, d.cell, d.house_number,
           d.electricity_meter_number, d.water_meter_number, d.caretaker_name, d.caretaker_phone
      from public.landlords_directory d
     order by d.created_at desc
     limit least(greatest(coalesce(p_limit, 2000), 1), 2000);
end $f$;
revoke all on function public.landlord_directory_browse(integer) from public, anon;
grant execute on function public.landlord_directory_browse(integer) to authenticated, service_role;
