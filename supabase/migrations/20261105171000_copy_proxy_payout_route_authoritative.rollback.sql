-- Restores 20261105160000 (staff keep any destination already on the row).
create or replace function public.copy_proxy_payout_on_file()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_partner uuid;
  v_kind text;
  v_id uuid;
  v_pay public.investor_portfolios%rowtype;
  v_saved public.saved_payout_methods%rowtype;
  v_extra public.portfolio_payout_destinations%rowtype;
  v_staff boolean := (select public.partner_record_staff_ok());
begin
  if new.proxy_partner_id is null or v_uid is null then
    return new;
  end if;
  if coalesce(new.agent_id, new.initiated_by) is distinct from v_uid then
    return new;
  end if;
  -- Staff who supplied their own destination keep it. Everyone else, and staff who sent none, get the route's.
  if v_staff and (coalesce(new.mobile_money_number, '') <> '' or coalesce(new.bank_account_number, '') <> '') then
    return new;
  end if;

  v_partner := new.proxy_partner_id;
  v_kind := split_part(coalesce(new.payout_route_ref, ''), ':', 1);
  begin
    v_id := split_part(coalesce(new.payout_route_ref, ''), ':', 2)::uuid;
  exception when others then
    v_id := null;
  end;

  new.mobile_money_number := null;
  new.mobile_money_provider := null;
  new.mobile_money_name := null;
  new.bank_name := null;
  new.bank_account_name := null;
  new.bank_account_number := null;

  if v_kind = 'portfolio' and v_id is not null then
    select * into v_pay
    from public.investor_portfolios p
    where p.id = v_id
      and p.investor_id = v_partner
      and (
        p.agent_id = v_uid
        or exists (
          select 1 from public.proxy_agent_assignments a
          where a.agent_id = v_uid and a.beneficiary_id = v_partner and a.is_active = true
        )
      );
    if v_pay.id is not null then
      if v_pay.payment_method ilike '%bank%' then
        new.payout_method := 'bank_transfer';
        new.bank_name := v_pay.bank_name;
        new.bank_account_name := coalesce(v_pay.bank_account_name, v_pay.account_name);
        new.bank_account_number := v_pay.account_number;
      elsif v_pay.payment_method ilike '%cash%' then
        new.payout_method := 'cash';
      else
        new.payout_method := 'mobile_money';
        new.mobile_money_provider := v_pay.mobile_network;
        new.mobile_money_number := v_pay.mobile_money_number;
        new.mobile_money_name := coalesce(v_pay.account_name, v_pay.bank_account_name);
      end if;
    end if;
  elsif v_kind = 'saved' and v_id is not null then
    select * into v_saved from public.saved_payout_methods s where s.id = v_id and s.user_id = v_partner;
    if v_saved.id is not null then
      if v_saved.payout_mode ilike '%bank%' then
        new.payout_method := 'bank_transfer';
        new.bank_name := v_saved.bank_name;
        new.bank_account_name := v_saved.bank_account_name;
        new.bank_account_number := v_saved.bank_account_number;
      elsif v_saved.payout_mode ilike '%cash%' then
        new.payout_method := 'cash';
      else
        new.payout_method := 'mobile_money';
        new.mobile_money_provider := v_saved.momo_provider;
        new.mobile_money_number := v_saved.momo_number;
        new.mobile_money_name := v_saved.momo_name;
      end if;
    end if;
  elsif v_kind = 'extra' and v_id is not null then
    select d.* into v_extra
    from public.portfolio_payout_destinations d
    join public.investor_portfolios p on p.id = d.portfolio_id
    where d.id = v_id
      and p.investor_id = v_partner
      and (
        p.agent_id = v_uid
        or exists (
          select 1 from public.proxy_agent_assignments a
          where a.agent_id = v_uid and a.beneficiary_id = v_partner and a.is_active = true
        )
      );
    if v_extra.id is not null then
      if v_extra.payout_method ilike '%bank%' then
        new.payout_method := 'bank_transfer';
        new.bank_name := v_extra.bank_name;
        new.bank_account_name := v_extra.recipient_name;
        new.bank_account_number := v_extra.account_number;
      else
        new.payout_method := 'mobile_money';
        new.mobile_money_provider := v_extra.mobile_network;
        new.mobile_money_number := v_extra.mobile_money_number;
        new.mobile_money_name := v_extra.recipient_name;
      end if;
    end if;
  end if;

  return new;
end $$;

revoke all on function public.copy_proxy_payout_on_file() from public, anon;
grant execute on function public.copy_proxy_payout_on_file() to authenticated, service_role;
