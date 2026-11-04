-- Partner read scope. Approved 4 Nov 2026. Not applied by this change.
-- 1. Drop the wide anon activation-token read. The share link uses get_portfolio_by_activation_token.
-- 2. Agents lose direct SELECT on investor_portfolios. They use agent_onboarded_portfolios
--    (name, masked code, amount, status, dates). Staff policies are unchanged.
-- 3. Proxy agents lose full profile SELECT. Promissory-note SELECT for agents is replaced
--    by a limited RPC. Payout destination numbers are not readable by agents.
-- Rollback: recreate the dropped policies from 20260304121914 / 20260709133504 / 20260413161139 /
--   20260818115703, and drop the functions and the restrictive payout policy added here.

-- ---------------------------------------------------------------------------
-- Activation link: one portfolio, display fields only, exact token match.
-- ---------------------------------------------------------------------------
create or replace function public.get_portfolio_by_activation_token(p_token uuid)
returns table (
  portfolio_code text,
  investment_amount numeric,
  duration_months integer,
  roi_percentage numeric,
  roi_mode text,
  status text,
  created_at timestamptz,
  next_roi_date date,
  maturity_date date,
  total_roi_earned numeric,
  agent_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.portfolio_code::text,
    p.investment_amount::numeric,
    p.duration_months::integer,
    p.roi_percentage::numeric,
    p.roi_mode::text,
    p.status::text,
    p.created_at,
    p.next_roi_date::date,
    p.maturity_date::date,
    coalesce(p.total_roi_earned, 0)::numeric,
    coalesce(ag.full_name, 'Agent')::text
  from public.investor_portfolios p
  left join public.profiles ag on ag.id = p.agent_id
  where p.activation_token = p_token
  limit 1
$$;

revoke all on function public.get_portfolio_by_activation_token(uuid) from public;
grant execute on function public.get_portfolio_by_activation_token(uuid) to anon, authenticated, service_role;

drop policy if exists "Anon can select by activation_token" on public.investor_portfolios;
drop policy if exists "Anon can select by specific activation_token" on public.investor_portfolios;
revoke all on public.investor_portfolios from anon;

-- ---------------------------------------------------------------------------
-- Agents: no direct portfolio rows. Staff keep their existing SELECT policies.
-- ---------------------------------------------------------------------------
drop policy if exists "Agents can select own portfolios" on public.investor_portfolios;

create or replace function public.agent_onboarded_portfolios()
returns table (
  portfolio_id uuid,
  investor_id uuid,
  partner_name text,
  portfolio_code_masked text,
  investment_amount numeric,
  total_roi_earned numeric,
  roi_percentage numeric,
  duration_months integer,
  status text,
  created_at timestamptz,
  next_roi_date date,
  maturity_date date
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select (select auth.uid()) as uid)
  select p.id,
    p.investor_id,
    coalesce(pr.full_name, 'Partner'),
    case
      when p.portfolio_code is null or length(p.portfolio_code) <= 4 then '****'
      else substr(p.portfolio_code, 1, 3) || repeat('*', greatest(length(p.portfolio_code) - 5, 2)) || right(p.portfolio_code, 2)
    end,
    p.investment_amount,
    coalesce(p.total_roi_earned, 0),
    p.roi_percentage,
    p.duration_months,
    p.status::text,
    p.created_at,
    p.next_roi_date::date,
    p.maturity_date::date
  from public.investor_portfolios p
  join me on p.agent_id = me.uid
  left join public.profiles pr on pr.id = p.investor_id
  where me.uid is not null
  union all
  select null::uuid,
    a.beneficiary_id,
    coalesce(pr.full_name, 'Partner'),
    null::text,
    0::numeric,
    0::numeric,
    null::numeric,
    null::integer,
    coalesce(a.approval_status, 'pending'),
    a.created_at,
    null::date,
    null::date
  from public.proxy_agent_assignments a
  join me on a.agent_id = me.uid
  left join public.profiles pr on pr.id = a.beneficiary_id
  where me.uid is not null
    and a.is_active = true
    and not exists (
      select 1 from public.investor_portfolios p
      where p.agent_id = a.agent_id and p.investor_id = a.beneficiary_id
    )
  order by created_at desc
  limit 200
$$;

revoke all on function public.agent_onboarded_portfolios() from public, anon;
grant execute on function public.agent_onboarded_portfolios() to authenticated, service_role;

-- Proxy agents no longer read a partner's full profile (phone, email, bank, mobile money).
drop policy if exists "Proxy agents can view partner profiles" on public.profiles;

-- ---------------------------------------------------------------------------
-- Promissory notes: agents list amount and status, not phone, email, or the token.
-- ---------------------------------------------------------------------------
drop policy if exists "Agents can view own promissory notes" on public.promissory_notes;

create or replace function public.agent_own_promissory_notes()
returns table (
  id uuid,
  partner_name text,
  amount numeric,
  contribution_type text,
  deduction_day integer,
  status text,
  total_collected numeric,
  next_deduction_date date,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.partner_name, n.amount, n.contribution_type, n.deduction_day, n.status,
    n.total_collected, n.next_deduction_date, n.created_at
  from public.promissory_notes n
  where n.agent_id = (select auth.uid())
    and (select auth.uid()) is not null
  order by n.created_at desc
  limit 200
$$;

revoke all on function public.agent_own_promissory_notes() from public, anon;
grant execute on function public.agent_own_promissory_notes() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Payout routes: method label only. Numbers stay on the server.
-- ---------------------------------------------------------------------------
create or replace function public.partner_record_staff_ok()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = (select auth.uid())
      and ur.enabled = true
      and ur.role::text in (
        'super_admin','admin','ceo','cto','coo','cfo','cmo','manager',
        'operations','hr','crm','partner_ops','financial_ops'
      )
  );
$$;

revoke all on function public.partner_record_staff_ok() from public, anon;
grant execute on function public.partner_record_staff_ok() to authenticated, service_role;

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

-- A permissive policy cannot outrank this. Agents do not read destination numbers.
alter table public.portfolio_payout_destinations enable row level security;
drop policy if exists "Payout destinations: staff or owning partner only" on public.portfolio_payout_destinations;
create policy "Payout destinations: staff or owning partner only"
  on public.portfolio_payout_destinations
  as restrictive
  for select
  to authenticated
  using (
    (select public.partner_record_staff_ok())
    or exists (
      select 1 from public.investor_portfolios p
      where p.id = portfolio_payout_destinations.portfolio_id
        and p.investor_id = (select auth.uid())
    )
  );

-- Proxy field agents no longer SELECT withdrawal rows (those rows hold payout numbers).
-- Cashout-agent and staff policies are unchanged.
drop policy if exists "Proxy initiators can view their proxy withdrawals" on public.withdrawal_requests;

create or replace function public.agent_proxy_withdrawal_summaries()
returns table (
  id uuid,
  user_id uuid,
  linked_party uuid,
  proxy_partner_id uuid,
  agent_id uuid,
  amount numeric,
  status text,
  payout_method text,
  reason text,
  rejection_reason text,
  created_at timestamptz,
  updated_at timestamptz,
  processed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select w.id, w.user_id, w.linked_party, w.proxy_partner_id, w.agent_id, w.amount, w.status::text,
    w.payout_method, w.reason, w.rejection_reason, w.created_at, w.updated_at, w.processed_at
  from public.withdrawal_requests w
  where (select auth.uid()) is not null
    and (w.agent_id = (select auth.uid()) or w.initiated_by = (select auth.uid()))
    and (w.proxy_partner_id is not null or w.linked_party is not null)
  order by w.created_at desc
  limit 500
$$;

revoke all on function public.agent_proxy_withdrawal_summaries() from public, anon;
grant execute on function public.agent_proxy_withdrawal_summaries() to authenticated, service_role;

create or replace function public.agent_proxy_withdrawal_id_for_client_request(p_client_request_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select w.id
  from public.withdrawal_requests w
  where w.client_request_id = p_client_request_id
    and (w.agent_id = (select auth.uid()) or w.initiated_by = (select auth.uid()))
  limit 1
$$;

revoke all on function public.agent_proxy_withdrawal_id_for_client_request(uuid) from public, anon;
grant execute on function public.agent_proxy_withdrawal_id_for_client_request(uuid) to authenticated, service_role;

-- Non-staff proxy inserts do not keep a number typed or read by the agent.
-- The route id is checked, then the number is copied from the portfolio or saved method.
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
begin
  if (select public.partner_record_staff_ok()) then
    return new;
  end if;
  if new.proxy_partner_id is null or v_uid is null then
    return new;
  end if;
  if coalesce(new.agent_id, new.initiated_by) is distinct from v_uid then
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

drop trigger if exists trg_00_proxy_copy_payout_on_file on public.withdrawal_requests;
create trigger trg_00_proxy_copy_payout_on_file
  before insert on public.withdrawal_requests
  for each row
  execute function public.copy_proxy_payout_on_file();
