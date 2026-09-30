
begin;

-- Staff salary reinvestment. Design approved by the CEO on 30 September 2026:
-- 20% per month, 12-month term, one portfolio per staff member topped up monthly,
-- no minimum, return option chosen by the staff member, no commissions.

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
  if not exists (select 1 from public.hr_pay_components where code = 'REINVEST') then
    raise exception 'REINVEST component missing. Apply the payroll reinvestment migration first.';
  end if;
end $$;

-- 1. One row per reinvested payslip. Also the marker that excludes a portfolio from
--    every commission trigger.
create table if not exists public.hr_pay_staff_reinvestments (
  id               uuid primary key default gen_random_uuid(),
  payslip_id       uuid not null unique references public.hr_pay_payslips(id),
  run_id           uuid not null references public.hr_pay_runs(id),
  staff_id         uuid not null references public.hr_staff(id),
  user_id          uuid not null,
  amount           numeric not null check (amount > 0),
  percentage       smallint,
  payout_mode      text not null check (payout_mode in ('monthly_payout','monthly_compounding')),
  portfolio_id     uuid not null references public.investor_portfolios(id),
  kind             text not null check (kind in ('portfolio_created','topup')),
  pending_op_id    uuid references public.pending_wallet_operations(id),
  ledger_group_id  uuid,
  created_at       timestamptz not null default now()
);

create index if not exists hr_pay_staff_reinvestments_portfolio_idx
  on public.hr_pay_staff_reinvestments (portfolio_id);
create index if not exists hr_pay_staff_reinvestments_user_idx
  on public.hr_pay_staff_reinvestments (user_id, created_at desc);

alter table public.hr_pay_staff_reinvestments enable row level security;

drop policy if exists hr_pay_staff_reinvestments_read on public.hr_pay_staff_reinvestments;
create policy hr_pay_staff_reinvestments_read on public.hr_pay_staff_reinvestments
  for select using (
    user_id = auth.uid()
    or public.hr_pay_is_rule_reader() or public.hr_pay_is_preparer()
    or public.hr_pay_is_approver() or public.hr_pay_is_releaser()
    or public.is_partner_ops(auth.uid())
  );

create or replace function public.hr_pay_is_staff_reinvest_portfolio(_portfolio_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select exists (select 1 from public.hr_pay_staff_reinvestments where portfolio_id = _portfolio_id);
$fn$;

revoke all on function public.hr_pay_is_staff_reinvest_portfolio(uuid) from public, anon, authenticated;

-- 2. Post one payslip's reinvestment. Internal only: called by hr_pay_post_run_reinvestments.
--    The reinvested salary never passes through the wallet: the company's salary cost goes
--    straight to partner capital (first month) or to the parked top-up account (later
--    months), exactly as a partner top-up is parked, and merged into principal after the
--    portfolio's next returns payout by the existing jobs.
create or replace function public.hr_pay_post_staff_reinvestment(_payslip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_existing   public.hr_pay_staff_reinvestments%rowtype;
  v_ps         record;
  v_amount     numeric;
  v_pct        smallint;
  v_mode       text;
  v_disb       text;
  v_pid        uuid;
  v_code       text;
  v_group      uuid;
  v_op         uuid;
  v_kind       text;
  v_payout_day int;
begin
  perform pg_advisory_xact_lock(hashtext('staff-reinvest-' || _payslip_id::text));

  select * into v_existing from public.hr_pay_staff_reinvestments where payslip_id = _payslip_id;
  if v_existing.id is not null then
    return jsonb_build_object('status', 'already_posted', 'portfolio_id', v_existing.portfolio_id,
                              'amount', v_existing.amount);
  end if;

  select ps.id, ps.run_id, ps.staff_id, ps.is_current, ps.inputs_snapshot,
         s.user_id, s.staff_ref, r.status as run_status, pe.code as period_code
    into v_ps
  from public.hr_pay_payslips ps
  join public.hr_staff s on s.id = ps.staff_id
  join public.hr_pay_runs r on r.id = ps.run_id
  join public.hr_pay_periods pe on pe.id = r.period_id
  where ps.id = _payslip_id;

  if v_ps.id is null then raise exception 'PAYSLIP_NOT_FOUND'; end if;
  if not v_ps.is_current then raise exception 'PAYSLIP_NOT_CURRENT'; end if;
  if v_ps.run_status not in ('approved','paid','locked') then
    raise exception 'RUN_NOT_APPROVED' using hint = v_ps.run_status;
  end if;

  select coalesce(sum(l.amount), 0) into v_amount
    from public.hr_pay_payslip_lines l
   where l.payslip_id = _payslip_id and l.component_code = 'REINVEST';
  if v_amount <= 0 then
    return jsonb_build_object('status', 'none');
  end if;

  select d.status into v_disb from public.hr_pay_disbursements d where d.payslip_id = _payslip_id limit 1;
  if coalesce(v_disb, '') not in ('posted','skipped') then
    raise exception 'SALARY_NOT_RELEASED' using hint = coalesce(v_disb, 'no disbursement');
  end if;

  if v_ps.user_id is null then raise exception 'STAFF_HAS_NO_USER'; end if;

  v_pct := nullif(v_ps.inputs_snapshot->'reinvestment'->>'percentage', '')::smallint;
  v_mode := nullif(v_ps.inputs_snapshot->'reinvestment'->>'payout_mode', '');
  if v_mode is null then
    select r.payout_mode into v_mode
      from public.staff_survey_responses r
      join public.staff_surveys sv on sv.id = r.survey_id and sv.kind = 'reinvestment_pledge'
     where r.user_id = v_ps.user_id and r.response = 'pledge' and r.payout_mode is not null
     order by r.cycle_start desc, r.responded_at desc
     limit 1;
  end if;
  if v_mode is null then raise exception 'RETURN_OPTION_NOT_CHOSEN'; end if;

  select r.portfolio_id into v_pid
    from public.hr_pay_staff_reinvestments r
    join public.investor_portfolios ip on ip.id = r.portfolio_id
   where r.user_id = v_ps.user_id
     and ip.status in ('pending_ops_approval','awaiting_partner_details','active')
   order by r.created_at desc
   limit 1;

  if v_pid is null then
    -- First reinvestment: a new staff portfolio, pending Partner Ops approval, already
    -- funded. No funder_pending_portfolios row is created, so approve_pending_portfolio
    -- activates it without charging any wallet.
    v_kind := 'portfolio_created';
    v_pid := gen_random_uuid();
    v_code := 'WSR' || to_char(now() at time zone 'UTC', 'YYMMDD')
              || lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');
    v_payout_day := least(extract(day from (now() at time zone 'UTC'))::int, 28);

    insert into public.investor_portfolios (
      id, investor_id, agent_id, portfolio_code, investment_amount,
      roi_percentage, roi_mode, duration_months, payout_day, next_roi_date,
      status, portfolio_pin, activation_token, auto_reinvest, investment_reference
    ) values (
      v_pid, v_ps.user_id, v_ps.user_id, v_code, v_amount,
      20, v_mode, 12, v_payout_day, ((now() at time zone 'UTC')::date + interval '1 month')::date,
      'pending_ops_approval', lpad((floor(random() * 9000) + 1000)::int::text, 4, '0'),
      gen_random_uuid(), false,
      'Staff salary reinvestment · ' || coalesce(v_ps.staff_ref, '')
    );

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_out', 'category', 'salary_payout',
          'ledger_scope', 'platform',
          'source_table', 'hr_pay_payslips', 'source_id', _payslip_id,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Salary reinvested by ' || coalesce(v_ps.staff_ref, 'staff')
                         || ' into staff portfolio ' || v_code),
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_in', 'category', 'partner_funding',
          'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Staff salary reinvestment capital received for portfolio ' || v_code
                         || ' (float_usage=portfolio_funding)')
      ),
      idempotency_key := 'staff-reinvest-' || _payslip_id::text
    );
  else
    -- Later months: a top-up parked on the same portfolio, exactly like a partner top-up.
    v_kind := 'topup';
    select portfolio_code into v_code from public.investor_portfolios where id = v_pid;

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_out', 'category', 'salary_payout',
          'ledger_scope', 'platform',
          'source_table', 'hr_pay_payslips', 'source_id', _payslip_id,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Salary reinvested by ' || coalesce(v_ps.staff_ref, 'staff')
                         || ' as a top-up to staff portfolio ' || v_code),
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_in', 'category', 'pending_portfolio_topup',
          'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Staff salary reinvestment top-up parked for portfolio ' || v_code)
      ),
      idempotency_key := 'staff-reinvest-' || _payslip_id::text
    );

    insert into public.pending_wallet_operations (
      user_id, amount, direction, category, description, source_table, source_id,
      transaction_group_id, linked_party, reference_id, status, operation_type,
      payment_method, metadata, created_at, updated_at
    ) values (
      v_ps.user_id, v_amount, 'cash_in', 'pending_portfolio_topup',
      'Staff salary reinvestment top-up for ' || v_code,
      'investor_portfolios', v_pid, v_group, v_ps.user_id::text, v_code,
      'pending', 'portfolio_topup', 'payroll',
      jsonb_build_object('fund_source', 'payroll', 'staff_reinvestment', true,
                         'payslip_id', _payslip_id, 'run_id', v_ps.run_id,
                         'portfolio_code', v_code, 'percentage', v_pct,
                         'payout_mode_chosen', v_mode),
      now(), now()
    )
    returning id into v_op;
  end if;

  insert into public.hr_pay_staff_reinvestments (
    payslip_id, run_id, staff_id, user_id, amount, percentage, payout_mode,
    portfolio_id, kind, pending_op_id, ledger_group_id
  ) values (
    _payslip_id, v_ps.run_id, v_ps.staff_id, v_ps.user_id, v_amount, v_pct, v_mode,
    v_pid, v_kind, v_op, v_group
  );

  insert into public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  values (null, 'hr_pay_staff_reinvestment', 'investor_portfolios', v_pid::text,
          'Staff salary reinvestment posted',
          jsonb_build_object('payslip_id', _payslip_id, 'run_id', v_ps.run_id,
                             'staff_ref', v_ps.staff_ref, 'amount', v_amount,
                             'percentage', v_pct, 'payout_mode', v_mode, 'kind', v_kind,
                             'portfolio_code', v_code, 'ledger_group_id', v_group));

  insert into public.notifications (user_id, title, message, type, metadata)
  values (v_ps.user_id, 'Salary reinvested',
          format('UGX %s from your %s salary has been reinvested into your Welile portfolio %s, earning 20%% per month.',
                 to_char(v_amount, 'FM999,999,999,999'), v_ps.period_code, v_code),
          'success',
          jsonb_build_object('portfolio_id', v_pid, 'amount', v_amount, 'kind', v_kind));

  return jsonb_build_object('status', 'posted', 'kind', v_kind, 'portfolio_id', v_pid,
                            'portfolio_code', v_code, 'amount', v_amount);
end;
$fn$;

revoke all on function public.hr_pay_post_staff_reinvestment(uuid) from public, anon, authenticated;

-- 3. Post every reinvestment on a run whose salary has been released. Called by the
--    release function (service role) and by the release authority from the run page.
--    Each payslip is posted in its own sub-transaction, so one failure never blocks
--    the others.
create or replace function public.hr_pay_post_run_reinvestments(_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  rec      record;
  v_res    jsonb;
  v_items  jsonb := '[]'::jsonb;
  v_posted int := 0;
  v_failed int := 0;
begin
  if not (coalesce(auth.role(), '') = 'service_role'
          or public.hr_pay_is_releaser() or public.hr_pay_is_rule_admin()) then
    raise exception 'Only the position holding release authority may post reinvestments.';
  end if;

  for rec in
    select ps.id as payslip_id, s.staff_ref
    from public.hr_pay_payslips ps
    join public.hr_staff s on s.id = ps.staff_id
    where ps.run_id = _run_id and ps.is_current
      and exists (select 1 from public.hr_pay_payslip_lines l
                  where l.payslip_id = ps.id and l.component_code = 'REINVEST' and l.amount > 0)
      and exists (select 1 from public.hr_pay_disbursements d
                  where d.payslip_id = ps.id and d.status in ('posted','skipped'))
      and not exists (select 1 from public.hr_pay_staff_reinvestments r where r.payslip_id = ps.id)
  loop
    begin
      v_res := public.hr_pay_post_staff_reinvestment(rec.payslip_id);
      if v_res->>'status' = 'posted' then v_posted := v_posted + 1; end if;
      v_items := v_items || jsonb_build_object('payslip_id', rec.payslip_id,
                                               'staff_ref', rec.staff_ref,
                                               'status', v_res->>'status');
    exception when others then
      v_failed := v_failed + 1;
      v_items := v_items || jsonb_build_object('payslip_id', rec.payslip_id,
                                               'staff_ref', rec.staff_ref,
                                               'status', 'failed', 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('posted', v_posted, 'failed', v_failed, 'items', v_items);
end;
$fn$;

revoke all on function public.hr_pay_post_run_reinvestments(uuid) from public, anon;
grant execute on function public.hr_pay_post_run_reinvestments(uuid) to authenticated, service_role;

-- 4. Reinvestments on a run, for the run page.
create or replace function public.hr_pay_run_reinvestments(_run_id uuid)
returns table(payslip_id uuid, staff_ref text, full_name text, amount numeric,
              percentage smallint, return_option text, status text,
              portfolio_code text, kind text, posted_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select ps.id, s.staff_ref::text, p.full_name::text,
         (select sum(l.amount) from public.hr_pay_payslip_lines l
           where l.payslip_id = ps.id and l.component_code = 'REINVEST'),
         coalesce(r.percentage, nullif(ps.inputs_snapshot->'reinvestment'->>'percentage', '')::smallint),
         coalesce(r.payout_mode,
                  nullif(ps.inputs_snapshot->'reinvestment'->>'payout_mode', ''),
                  (select sr.payout_mode from public.staff_survey_responses sr
                     join public.staff_surveys sv on sv.id = sr.survey_id and sv.kind = 'reinvestment_pledge'
                    where sr.user_id = s.user_id and sr.response = 'pledge' and sr.payout_mode is not null
                    order by sr.cycle_start desc, sr.responded_at desc limit 1)),
         case when r.id is not null then 'posted' else 'pending' end,
         ip.portfolio_code::text, r.kind, r.created_at
  from public.hr_pay_payslips ps
  join public.hr_staff s on s.id = ps.staff_id
  left join public.profiles p on p.id = s.user_id
  left join public.hr_pay_staff_reinvestments r on r.payslip_id = ps.id
  left join public.investor_portfolios ip on ip.id = r.portfolio_id
  where ps.run_id = _run_id and ps.is_current
    and exists (select 1 from public.hr_pay_payslip_lines l
                where l.payslip_id = ps.id and l.component_code = 'REINVEST' and l.amount > 0)
    and (public.hr_pay_is_rule_reader() or public.hr_pay_is_preparer()
         or public.hr_pay_is_approver() or public.hr_pay_is_releaser())
  order by s.staff_ref;
$fn$;

revoke all on function public.hr_pay_run_reinvestments(uuid) from public, anon;
grant execute on function public.hr_pay_run_reinvestments(uuid) to authenticated;

-- 5. A run cannot be recorded as paid while any of its reinvestments is unposted.
create or replace function public.hr_pay_reinvest_paid_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_missing int;
begin
  if new.event_type <> 'paid' then return new; end if;
  select count(*) into v_missing
    from public.hr_pay_payslips ps
   where ps.run_id = new.run_id and ps.is_current
     and exists (select 1 from public.hr_pay_payslip_lines l
                 where l.payslip_id = ps.id and l.component_code = 'REINVEST' and l.amount > 0)
     and not exists (select 1 from public.hr_pay_staff_reinvestments r where r.payslip_id = ps.id);
  if v_missing > 0 then
    raise exception
      'Cannot record payment: % salary reinvestment(s) have not been posted into Partner Ops. Use Post reinvestments on the run page first.',
      v_missing;
  end if;
  return new;
end;
$fn$;

drop trigger if exists zz_hr_pay_reinvest_paid_guard_trg on public.hr_pay_run_events;
create trigger zz_hr_pay_reinvest_paid_guard_trg
  before insert on public.hr_pay_run_events
  for each row execute function public.hr_pay_reinvest_paid_guard();

-- 6. No commission on any staff reinvestment portfolio. Each function below is its
--    existing body with one guard added at the top, marked NEW.
create or replace function public.trg_proxy_agent_portfolio_commission()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
DECLARE
  v_delta numeric;
BEGIN
  -- NEW: staff salary reinvestment portfolios earn no commission.
  IF public.hr_pay_is_staff_reinvest_portfolio(NEW.id) THEN RETURN NULL; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'active' AND coalesce(NEW.investment_amount, 0) > 0 THEN
      PERFORM public.try_credit_proxy_agent_portfolio_commission(
        NEW.investor_id,
        NEW.investment_amount,
        'portfolio_creation',
        'investor_portfolios',
        NEW.id,
        NEW.id::text
      );
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status = 'active'
     AND coalesce(OLD.status, '') <> 'active'
     AND coalesce(NEW.investment_amount, 0) > 0 THEN
    PERFORM public.try_credit_proxy_agent_portfolio_commission(
      NEW.investor_id,
      NEW.investment_amount,
      'portfolio_creation',
      'investor_portfolios',
      NEW.id,
      NEW.id::text
    );
    RETURN NULL;
  END IF;

  v_delta := coalesce(NEW.investment_amount, 0) - coalesce(OLD.investment_amount, 0);
  IF v_delta > 0 AND NEW.status = 'active' THEN
    PERFORM public.try_credit_proxy_agent_portfolio_commission(
      NEW.investor_id,
      v_delta,
      'portfolio_topup',
      'investor_portfolios',
      NEW.id,
      NEW.id::text || ':' || round(coalesce(NEW.investment_amount, 0))::text
    );
  END IF;

  RETURN NULL;
END;
$fn$;

create or replace function public.trg_promissory_commission_portfolio()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
DECLARE v_delta numeric;
BEGIN
  -- NEW: staff salary reinvestment portfolios earn no commission.
  IF public.hr_pay_is_staff_reinvest_portfolio(NEW.id) THEN RETURN NULL; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'active' AND coalesce(NEW.investment_amount,0) > 0 THEN
      PERFORM public.try_credit_promissory_agent_commission(
        NEW.investor_id, NEW.investment_amount, 'portfolio_creation',
        'investor_portfolios', NEW.id, NEW.id::text);
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status = 'active' AND coalesce(OLD.status,'') <> 'active'
     AND coalesce(NEW.investment_amount,0) > 0 THEN
    PERFORM public.try_credit_promissory_agent_commission(
      NEW.investor_id, NEW.investment_amount, 'portfolio_creation',
      'investor_portfolios', NEW.id, NEW.id::text);
    RETURN NULL;
  END IF;

  v_delta := coalesce(NEW.investment_amount,0) - coalesce(OLD.investment_amount,0);
  IF v_delta > 0 AND NEW.status = 'active' THEN
    PERFORM public.try_credit_promissory_agent_commission(
      NEW.investor_id, v_delta, 'portfolio_topup',
      'investor_portfolios', NEW.id,
      NEW.id::text || ':' || round(coalesce(NEW.investment_amount,0))::text);
  END IF;

  RETURN NULL;
END;
$fn$;

create or replace function public.trg_proxy_agent_portfolio_topup_commission()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
DECLARE
  v_partner_id uuid;
BEGIN
  -- NEW: top-ups to staff salary reinvestment portfolios earn no commission.
  IF NEW.source_table = 'investor_portfolios' AND NEW.source_id IS NOT NULL
     AND public.hr_pay_is_staff_reinvest_portfolio(NEW.source_id) THEN
    RETURN NULL;
  END IF;

  IF NEW.operation_type = 'portfolio_topup'
     AND NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status, '') <> 'approved')
     AND coalesce(NEW.amount, 0) > 0 THEN

    SELECT p.investor_id
      INTO v_partner_id
    FROM public.investor_portfolios p
    WHERE p.id = NEW.source_id
    LIMIT 1;

    PERFORM public.try_credit_proxy_agent_portfolio_commission(
      coalesce(v_partner_id, NEW.user_id),
      NEW.amount,
      'portfolio_topup',
      'pending_wallet_operations',
      NEW.id,
      NEW.id::text
    );
  END IF;
  RETURN NULL;
END;
$fn$;

create or replace function public.trg_credit_promissory_portfolio_topup()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
DECLARE
  v_partner_id uuid;
BEGIN
  -- NEW: top-ups to staff salary reinvestment portfolios earn no commission.
  IF NEW.source_table = 'investor_portfolios' AND NEW.source_id IS NOT NULL
     AND public.hr_pay_is_staff_reinvest_portfolio(NEW.source_id) THEN
    RETURN NEW;
  END IF;

  IF NEW.operation_type = 'portfolio_topup'
     AND NEW.source_table = 'investor_portfolios'
     AND NEW.source_id IS NOT NULL
     AND coalesce(NEW.amount, 0) > 0
     AND NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status, '') IS DISTINCT FROM NEW.status) THEN
    SELECT ip.investor_id
      INTO v_partner_id
      FROM public.investor_portfolios ip
     WHERE ip.id = NEW.source_id;

    PERFORM public.try_credit_promissory_agent_commission(
      coalesce(v_partner_id, NEW.user_id),
      NEW.amount,
      'portfolio_topup',
      'pending_wallet_operations',
      NEW.id,
      NEW.id::text
    );
  END IF;
  RETURN NEW;
END;
$fn$;

commit;
