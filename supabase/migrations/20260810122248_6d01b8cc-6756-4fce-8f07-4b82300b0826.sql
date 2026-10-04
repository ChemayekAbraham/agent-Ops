create or replace function public.my_partner_lead_agents()
returns table(agent_id uuid, full_name text, phone text, attached_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;

  return query
  select pa.agent_id,
         coalesce(p.full_name, 'Unnamed agent') as full_name,
         p.phone,
         pa.attached_at
    from public.partner_lead_assignments pa
    left join public.profiles p on p.id = pa.agent_id
   where pa.lead_user_id = auth.uid()
     and pa.detached_at is null
   order by pa.attached_at desc;
end;
$$;

grant execute on function public.my_partner_lead_agents() to authenticated;