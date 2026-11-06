-- Assistant follow-ups from the 60-question live test (2026-11-05).
--
-- 1. assistant_messages.guard_reason: why the output guard blocked or retried a reply. A blocked
--    answer used to leave no trace of its cause, so it could not be diagnosed. Staff-only: it is
--    never returned to the person chatting.
-- 2. assistant_partner_portfolio_detail now returns compounded_so_far (the total), because the
--    assistant cannot add up the individual compounding entries itself.

alter table public.assistant_messages add column if not exists guard_reason text;

create or replace function public.assistant_partner_portfolio_detail(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_code  text := nullif(btrim(left(coalesce(p_code, ''), 40)), '');
  v_p     public.investor_portfolios%rowtype;
  v_n     integer;
  v_dest  jsonb;
begin
  perform public.assistant_require_partner();

  if v_code is null then
    raise exception 'code_required' using errcode = '22023';
  end if;

  select count(*) into v_n from public.investor_portfolios ip
   where ip.investor_id = v_uid and ip.status <> 'cancelled' and lower(ip.portfolio_code) = lower(v_code);
  if v_n = 0 then
    return jsonb_build_object('found', false, 'code', v_code);
  end if;

  select * into v_p from public.investor_portfolios ip
   where ip.investor_id = v_uid and ip.status <> 'cancelled' and lower(ip.portfolio_code) = lower(v_code)
   limit 1;

  select jsonb_build_object(
           'method', d.payout_method, 'network', d.mobile_network, 'bank', d.bank_name,
           'name', d.recipient_name,
           'number', coalesce(public.assistant_mask_tail(d.mobile_money_number), public.assistant_mask_tail(d.account_number)))
    into v_dest
    from public.portfolio_payout_destinations d
   where d.portfolio_id = v_p.id
   order by d.updated_at desc limit 1;

  if v_dest is null then
    v_dest := jsonb_build_object(
      'method', v_p.payment_method, 'network', v_p.mobile_network, 'bank', v_p.bank_name,
      'name', coalesce(v_p.account_name, v_p.bank_account_name),
      'number', coalesce(public.assistant_mask_tail(v_p.mobile_money_number), public.assistant_mask_tail(v_p.account_number)));
  end if;

  return jsonb_build_object(
    'found', true,
    'code', v_p.portfolio_code,
    'name', v_p.account_name,
    'status', v_p.status,
    'mode', case when v_p.roi_mode in ('monthly_compounding', 'compound') then 'compounding' else 'monthly payout' end,
    'auto_reinvest_on', coalesce(v_p.auto_reinvest, false),
    'rate_percent', v_p.roi_percentage,
    'current_value', v_p.investment_amount,
    'duration_months', v_p.duration_months,
    'started_on', (v_p.created_at at time zone 'Africa/Kampala')::date,
    'maturity_date', v_p.maturity_date,
    'days_to_maturity', v_p.maturity_date - v_today,
    'next_returns_date', v_p.next_roi_date,
    'next_returns_date_has_passed', (v_p.next_roi_date is not null and v_p.next_roi_date < v_today),
    'payout_day', v_p.payout_day,
    'standard_monthly_returns_estimate',
       case when v_p.status = 'active' and v_p.roi_mode not in ('monthly_compounding', 'compound')
            then round(v_p.investment_amount * v_p.roi_percentage / 100) end,
    'returns_on_hold', exists (select 1 from public.portfolio_return_holds h where h.portfolio_id = v_p.id and h.released_at is null),
    'renewal_scheduled', jsonb_build_object(
        'scheduled', v_p.pending_renewal_effective_date is not null,
        'effective_date', v_p.pending_renewal_effective_date,
        'new_duration_months', v_p.pending_renewal_duration_months),
    'payout_destination', v_dest,
    -- The total is calculated here so the model never adds the entries up itself.
    'compounded_so_far', case when v_p.roi_mode in ('monthly_compounding', 'compound') then (
       select coalesce(round(sum((a.metadata ->> 'roi_amount')::numeric)), 0)
         from public.audit_logs a
        where a.action_type = 'roi_compounded' and a.table_name = 'investor_portfolios'
          and a.record_id = v_p.id::text) end,
    'compounds', coalesce((
      select jsonb_agg(jsonb_build_object('date', c.d, 'amount', c.amt) order by c.d desc) from (
        select (a.created_at at time zone 'Africa/Kampala')::date as d, (a.metadata ->> 'roi_amount')::numeric as amt
          from public.audit_logs a
         where a.action_type = 'roi_compounded' and a.table_name = 'investor_portfolios' and a.record_id = v_p.id::text
         order by a.created_at desc limit 24) c), '[]'::jsonb),
    -- Top-ups that were reversed (the audit trail records the operation id) or cancelled are not shown.
    'topups', coalesce((
      select jsonb_agg(jsonb_build_object('date', t.d, 'amount', t.amount, 'status', t.status) order by t.d desc) from (
        select (o.created_at at time zone 'Africa/Kampala')::date as d, o.amount, o.status
          from public.pending_wallet_operations o
         where o.operation_type = 'portfolio_topup' and o.source_table = 'investor_portfolios' and o.source_id = v_p.id
           and o.status in ('completed', 'approved', 'pending', 'processing')
           and not exists (
                 select 1 from public.audit_logs ra
                  where ra.table_name = 'investor_portfolios' and ra.record_id = v_p.id::text
                    and ra.action_type in ('reverse_merged_topup_row', 'revert_premature_topup_merge')
                    and ra.metadata ->> 'op_id' = o.id::text)
         order by o.created_at desc limit 20) t), '[]'::jsonb),
    'renewals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', (r.created_at at time zone 'Africa/Kampala')::date,
               'automatic', coalesce(r.is_auto, false),
               'old_maturity_date', r.old_maturity_date, 'new_maturity_date', r.new_maturity_date,
               'old_rate_percent', r.old_roi_percentage, 'new_rate_percent', r.new_roi_percentage,
               'old_duration_months', r.old_duration_months, 'new_duration_months', r.new_duration_months,
               'top_up_amount', r.top_up_amount) order by r.created_at desc)
        from (select * from public.portfolio_renewals pr
               where pr.portfolio_id = v_p.id and pr.reversed_at is null
               order by pr.created_at desc limit 10) r), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'type', case q.request_type when 'RENEWAL_REQUEST' then 'renewal' when 'REDEMPTION_REQUEST' then 'redemption' else lower(q.request_type) end,
               'status', q.status, 'requested_on', (q.created_at at time zone 'Africa/Kampala')::date,
               'redemption_scope', q.redemption_scope, 'redemption_amount', q.redemption_amount,
               'notice_ends_on', q.notice_ends_on) order by q.created_at desc)
        from (select * from public.portfolio_action_requests par
               where par.portfolio_id = v_p.id and par.partner_id = v_uid and par.status <> 'cancelled'
               order by par.created_at desc limit 10) q), '[]'::jsonb),
    'redemptions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', (d.created_at at time zone 'Africa/Kampala')::date, 'scope', d.scope,
               'amount', d.redeemed_amount, 'remaining_principal', d.remaining_principal,
               'paid', (d.payout_status = 'paid')) order by d.created_at desc)
        from (select * from public.portfolio_redemptions pd
               where pd.portfolio_id = v_p.id and not coalesce(pd.is_test, false)
               order by pd.created_at desc limit 10) d), '[]'::jsonb),
    'payouts_paid', coalesce((
      select jsonb_agg(jsonb_build_object('date', (w.processed_at at time zone 'Africa/Kampala')::date, 'amount', w.amount) order by w.processed_at desc)
        from (select * from public.withdrawal_requests wr
               where wr.user_id = v_uid and wr.status = 'completed' and wr.payout_route_ref = 'portfolio:' || v_p.id::text
               order by wr.processed_at desc limit 12) w), '[]'::jsonb),
    'maturity_notice', (
      select jsonb_build_object('maturity_date', n.maturity_date, 'sent_on', (n.sent_at at time zone 'Africa/Kampala')::date)
        from public.portfolio_maturity_notices n
       where n.portfolio_id = v_p.id order by n.sent_at desc nulls last limit 1));
end;
$$;

revoke execute on function public.assistant_partner_portfolio_detail(text) from public, anon;
grant  execute on function public.assistant_partner_portfolio_detail(text) to authenticated, service_role;
