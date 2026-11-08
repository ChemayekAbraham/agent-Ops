-- Production text of hr_pay_post_staff_reinvestment(uuid) as read from byrzshwlentqvktcksem on
-- 2026-11-06 (md5(pg_get_functiondef) ed4cc123465f945d282e109f8770a22b, same as the Phase 0 manifest).
-- Used by phase2_test.sql only: proves assert_partner_return_policy_intact() catches a revert.
CREATE OR REPLACE FUNCTION public.hr_pay_post_staff_reinvestment(_payslip_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  select ps.id, ps.run_id, ps.staff_id, ps.is_current, ps.inputs_snapshot, ps.net,
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
  if coalesce(v_ps.net, 0) > 0 and coalesce(v_disb, '') not in ('posted','skipped') then
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
      'awaiting_partner_details', lpad((floor(random() * 9000) + 1000)::int::text, 4, '0'),
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
$function$
;
