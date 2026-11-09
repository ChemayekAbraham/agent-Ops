-- Proxy agent confirms a partner's payout details (name + number) before sending a withdrawal.
-- Decision (CTO, 2026-11-05): the assigned proxy agent must see the partner's payout name and number on the
-- confirm screen, as she did before 20261104244000 hid them. That migration stays in force for tables and for
-- agent_partner_payout_routes (labels only); this adds ONE narrow, caller-checked RPC that returns the destination of
-- ONE route of ONE partner the caller is the agent of, or an active approved proxy for. No table policy is loosened.
-- Rollback: 20261105150000_agent_partner_payout_destination.rollback.sql

create or replace function public.agent_partner_payout_destination(p_partner_id uuid, p_route_key text)
returns table (
  out_mode text,
  out_provider text,
  out_name text,
  out_number text,
  out_bank text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_kind text := split_part(coalesce(p_route_key, ''), ':', 1);
  v_id uuid;
begin
  if v_uid is null or p_partner_id is null then
    return;
  end if;
  begin
    v_id := split_part(coalesce(p_route_key, ''), ':', 2)::uuid;
  exception when others then
    return;
  end;

  if not (
    exists (select 1 from public.investor_portfolios p where p.investor_id = p_partner_id and p.agent_id = v_uid)
    or exists (
      select 1 from public.proxy_agent_assignments a
      where a.beneficiary_id = p_partner_id and a.agent_id = v_uid
        and a.is_active = true and a.approval_status = 'approved'
    )
  ) then
    return;
  end if;

  if v_kind = 'portfolio' then
    return query
    select case when p.payment_method ilike '%bank%' then 'bank_transfer'
                when p.payment_method ilike '%cash%' then 'cash'
                else 'mobile_money' end,
      p.mobile_network::text,
      case when p.payment_method ilike '%bank%' then coalesce(p.bank_account_name, p.account_name)
           else coalesce(p.account_name, p.bank_account_name) end::text,
      case when p.payment_method ilike '%bank%' then p.account_number else p.mobile_money_number end::text,
      p.bank_name::text
    from public.investor_portfolios p
    where p.id = v_id and p.investor_id = p_partner_id;
  elsif v_kind = 'saved' then
    return query
    select case when s.payout_mode ilike '%bank%' then 'bank_transfer'
                when s.payout_mode ilike '%cash%' then 'cash'
                else 'mobile_money' end,
      s.momo_provider::text,
      case when s.payout_mode ilike '%bank%' then s.bank_account_name else s.momo_name end::text,
      case when s.payout_mode ilike '%bank%' then s.bank_account_number else s.momo_number end::text,
      s.bank_name::text
    from public.saved_payout_methods s
    where s.id = v_id and s.user_id = p_partner_id;
  elsif v_kind = 'extra' then
    return query
    select case when d.payout_method ilike '%bank%' then 'bank_transfer' else 'mobile_money' end,
      d.mobile_network::text,
      d.recipient_name::text,
      case when d.payout_method ilike '%bank%' then d.account_number else d.mobile_money_number end::text,
      d.bank_name::text
    from public.portfolio_payout_destinations d
    join public.investor_portfolios p on p.id = d.portfolio_id
    where d.id = v_id and p.investor_id = p_partner_id;
  end if;
end $$;

revoke all on function public.agent_partner_payout_destination(uuid, text) from public, anon;
grant execute on function public.agent_partner_payout_destination(uuid, text) to authenticated, service_role;
