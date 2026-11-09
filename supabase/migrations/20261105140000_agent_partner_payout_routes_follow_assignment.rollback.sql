-- Restores the 20261104244000 definition (portfolio and extra branches require investor_portfolios.agent_id = caller).
create or replace function public.agent_partner_payout_routes(p_partner_id uuid)
returns table (
  route_key text,
  portfolio_id uuid,
  payout_mode text,
  label text
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select (select auth.uid()) as uid),
  allowed as (
    select me.uid
    from me
    where me.uid is not null
      and (
        exists (
          select 1 from public.investor_portfolios p
          where p.investor_id = p_partner_id and p.agent_id = me.uid
        )
        or exists (
          select 1 from public.proxy_agent_assignments a
          where a.beneficiary_id = p_partner_id and a.agent_id = me.uid and a.is_active = true
        )
      )
  )
  select ('portfolio:' || p.id::text),
    p.id,
    case
      when p.payment_method ilike '%bank%' then 'bank_transfer'
      when p.payment_method ilike '%cash%' then 'cash'
      else 'mobile_money'
    end,
    case
      when p.payment_method ilike '%bank%' then 'Bank transfer on file'
      when p.payment_method ilike '%cash%' then 'Cash on file'
      else 'Mobile money on file'
    end
  from public.investor_portfolios p
  join allowed on true
  where p.investor_id = p_partner_id
    and p.agent_id = (select uid from allowed)
    and coalesce(p.payment_method, '') <> ''
  union all
  select ('extra:' || d.id::text),
    d.portfolio_id,
    case when d.payout_method ilike '%bank%' then 'bank_transfer' else 'mobile_money' end,
    case when d.payout_method ilike '%bank%' then 'Extra bank payout on file' else 'Extra mobile money payout on file' end
  from public.portfolio_payout_destinations d
  join public.investor_portfolios p on p.id = d.portfolio_id
  join allowed on true
  where p.investor_id = p_partner_id
    and p.agent_id = (select uid from allowed)
  union all
  select ('saved:' || s.id::text),
    null::uuid,
    case
      when s.payout_mode ilike '%bank%' then 'bank_transfer'
      when s.payout_mode ilike '%cash%' then 'cash'
      else 'mobile_money'
    end,
    case
      when s.payout_mode ilike '%bank%' then 'Saved bank payout on file'
      when s.payout_mode ilike '%cash%' then 'Saved cash payout on file'
      else 'Saved mobile money payout on file'
    end
  from public.saved_payout_methods s
  join allowed on true
  where s.user_id = p_partner_id
$$;

revoke all on function public.agent_partner_payout_routes(uuid) from public, anon;
grant execute on function public.agent_partner_payout_routes(uuid) to authenticated, service_role;
