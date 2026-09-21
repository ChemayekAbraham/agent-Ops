create or replace function public.partner_house_placement_status(p_partner_id uuid default null)
returns table (
  house_id uuid,
  title text,
  house_category text,
  district text,
  sub_county text,
  village text,
  image_url text,
  monthly_rent numeric,
  principal numeric,
  status text,
  listing_agent_id uuid,
  agent_name text,
  supported_at timestamptz,
  placed_at timestamptz,
  days_to_place integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_partner uuid := coalesce(p_partner_id, auth.uid());
begin
  if v_caller is null then
    raise exception 'not_authenticated';
  end if;

  if v_partner <> v_caller and not (
    public.is_partner_ops(v_caller)
    or public.has_role(v_caller, 'cfo')
    or public.has_role(v_caller, 'ceo')
    or public.has_role(v_caller, 'coo')
    or public.has_role(v_caller, 'financial_ops')
    or public.has_role(v_caller, 'manager')
    or public.has_role(v_caller, 'super_admin')
  ) then
    raise exception 'not_authorized';
  end if;

  return query
  select
    psh.house_id,
    hl.title,
    hl.house_category,
    hl.district,
    hl.sub_county,
    hl.village,
    hl.image_urls[1] as image_url,
    hl.monthly_rent,
    psh.principal,
    psh.status,
    psh.listing_agent_id,
    pr.full_name as agent_name,
    psh.supported_at,
    coalesce(psh.activated_at, haa.assigned_at) as placed_at,
    case
      when coalesce(psh.activated_at, haa.assigned_at) is not null and psh.supported_at is not null
        then greatest(0, floor(extract(epoch from (coalesce(psh.activated_at, haa.assigned_at) - psh.supported_at)) / 86400)::integer)
      else null
    end as days_to_place
  from public.partner_supported_houses psh
  left join public.house_listings hl on hl.id = psh.house_id
  left join public.profiles pr on pr.id = psh.listing_agent_id
  left join lateral (
    select a.assigned_at
    from public.house_assignment_audit a
    where a.house_listing_id = psh.house_id
    order by a.assigned_at desc
    limit 1
  ) haa on true
  where psh.partner_id = v_partner
    and psh.status <> 'cancelled'
  order by psh.supported_at desc nulls last;
end;
$$;

revoke all on function public.partner_house_placement_status(uuid) from public;
grant execute on function public.partner_house_placement_status(uuid) to authenticated;