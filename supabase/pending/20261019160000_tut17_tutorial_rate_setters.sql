
create or replace function public.ops_tutorial_is_rate_setter()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles ur
                 where ur.user_id = auth.uid() and ur.enabled and ur.role::text = 'hr')
      or exists (select 1 from public.staff_requisition_offices o
                 where o.holder_id = auth.uid() and o.office_key in ('coo','ceo','cfo'));
$$;
revoke all on function public.ops_tutorial_is_rate_setter() from public, anon;
grant execute on function public.ops_tutorial_is_rate_setter() to authenticated;

create or replace function public.ops_tutorial_my_capabilities()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'is_staff',      coalesce(public.is_welile_staff(auth.uid()), false),
    'is_creator',    public.ops_tutorial_is_member('creator'),
    'is_reviewer',   public.ops_tutorial_is_member('reviewer'),
    'is_admin',      public.hr_is_admin(),
    'can_set_rates', public.ops_tutorial_is_rate_setter());
$$;
revoke all on function public.ops_tutorial_my_capabilities() from public, anon;
grant execute on function public.ops_tutorial_my_capabilities() to authenticated;

create or replace function public.ops_tutorial_set_rate(p_tier text, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_old numeric;
begin
  if not public.ops_tutorial_is_rate_setter() then
    raise exception 'Only HR, the COO, CEO or CFO can set tutorial rates';
  end if;
  if p_tier not in ('basic','standard','advanced','revision') then
    raise exception 'Unknown tier';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'Amount must be zero or more';
  end if;
  select amount_ugx into v_old from public.ops_tutorial_rates where tier = p_tier;
  insert into public.ops_tutorial_rates (tier, amount_ugx, updated_by, updated_at)
  values (p_tier, p_amount, auth.uid(), now())
  on conflict (tier) do update
    set amount_ugx = excluded.amount_ugx, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, old_values, new_values, metadata)
  values (auth.uid(), 'ops_tutorial_rate_set', 'ops_tutorial_rates', p_tier,
          case when v_old is null then null else jsonb_build_object('amount_ugx', v_old) end,
          jsonb_build_object('amount_ugx', p_amount),
          jsonb_build_object('tier', p_tier));
end $$;
revoke all on function public.ops_tutorial_set_rate(text, numeric) from public, anon;
grant execute on function public.ops_tutorial_set_rate(text, numeric) to authenticated;

