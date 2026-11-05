-- Agent assistant, partner persona: no reversals, no admin corrections.
--
-- A partner must not see reversals or admin corrections on their portfolios or in their wallet
-- details. This replaces five functions from 20261105110000 and adds the wallet activity tool.
--
--   * Wallet activity uses the platform's own customer-visibility rule
--     (is_customer_wallet_history_visible: hides classification 'admin_correction', correction and
--     reconciliation categories, reversal descriptions) AND an allowlist of partner-facing
--     categories, so a correction or reversal category nobody has met yet stays hidden (fail
--     closed). Descriptions, references, counterparties and running balances are never returned:
--     the running balance is built from every entry, corrections included.
--   * Reversed renewals and reversed or cancelled top-ups are left out of the portfolio views.
--   * Balances are the real balances; only the line items are filtered, so the listed activity is
--     not guaranteed to add up to the balance. The tool description tells the model never to try.
--   * Returns "earned" stays NET of ledger reversals. Dropping the reversal rows would count money
--     that was reversed as earned. Nothing in the answer names or lists a reversal.

-- ---------------------------------------------------------------------------
-- Overview: the "last credited to my wallet" figure uses the same visibility rule
-- ---------------------------------------------------------------------------

create or replace function public.assistant_partner_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_today  date := (now() at time zone 'Africa/Kampala')::date;
  v_month0 timestamptz := (date_trunc('month', v_today)::timestamp at time zone 'Africa/Kampala');
  v_result jsonb;
begin
  perform public.assistant_require_partner();

  with mine as (
    select ip.id, ip.portfolio_code, ip.status, ip.roi_mode, ip.investment_amount,
           ip.next_roi_date, ip.maturity_date, ip.created_at
      from public.investor_portfolios ip
     where ip.investor_id = v_uid and ip.status <> 'cancelled'
  ), active as (
    select * from mine where status = 'active'
  ), ret as (
    select gl.created_at,
           case when gl.direction = 'cash_out' then gl.amount else -gl.amount end as amt
      from public.general_ledger gl
     where gl.category = 'roi_expense'
       and gl.ledger_scope = 'platform'
       and gl.source_table = 'investor_portfolios'
       and gl.source_id in (select id from mine)
  ), credited as (
    select gl.amount, gl.created_at
      from public.general_ledger gl
     where gl.user_id = v_uid and gl.ledger_scope = 'wallet'
       and gl.category = 'roi_wallet_credit' and gl.direction = 'cash_in'
       and public.is_customer_wallet_history_visible(
             gl.user_id, gl.classification, gl.category, gl.source_table, gl.description, gl.reference_id, gl.source_id)
  ), next_payout as (
    select a.portfolio_code, a.next_roi_date
      from active a
     where a.roi_mode not in ('monthly_compounding', 'compound') and a.next_roi_date >= v_today
     order by a.next_roi_date, a.portfolio_code limit 1
  ), next_maturity as (
    select a.portfolio_code, a.maturity_date
      from active a where a.maturity_date >= v_today
     order by a.maturity_date, a.portfolio_code limit 1
  ), agr as (
    select * from public.partner_agreements pa
     where pa.partner_id = v_uid order by pa.created_at desc limit 1
  ), accepted as (
    select s.agreement_version, s.accepted_at, s.status
      from public.supporter_agreement_acceptance s
     where s.supporter_id = v_uid order by s.accepted_at desc limit 1
  )
  select jsonb_build_object(
    'name',            (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = v_uid),
    'partner_since',   (select (min(created_at) at time zone 'Africa/Kampala')::date from mine),
    'portfolios', jsonb_build_object(
      'total',   (select count(*) from mine),
      'active',  (select count(*) from active),
      'locked',  (select count(*) from mine where status = 'locked'),
      'redeemed',(select count(*) from mine where status = 'redeemed'),
      'pending', (select count(*) from mine where status in ('pending_ops_approval', 'awaiting_partner_details')),
      'compounding_active', (select count(*) from active where roi_mode in ('monthly_compounding', 'compound')),
      'payout_active',      (select count(*) from active where roi_mode not in ('monthly_compounding', 'compound')),
      'active_principal',   (select coalesce(sum(investment_amount), 0) from active)),
    'returns', jsonb_build_object(
      'earned_total',        (select coalesce(round(sum(amt)), 0) from ret),
      'earned_this_month',   (select coalesce(round(sum(amt) filter (where created_at >= v_month0)), 0) from ret),
      'last_credit_to_my_wallet_amount', (select round(amount) from credited order by created_at desc limit 1),
      'last_credit_to_my_wallet_date',   (select (created_at at time zone 'Africa/Kampala')::date from credited order by created_at desc limit 1)),
    'wallet', jsonb_build_object(
      'withdrawable_balance', (select coalesce(w.withdrawable_balance, 0) from public.wallets w where w.user_id = v_uid limit 1),
      'locked_balance',       (select coalesce(w.locked_balance, 0) from public.wallets w where w.user_id = v_uid limit 1),
      'float_available_for_topups', public.funder_float_available(v_uid)),
    'next_returns_payout', (select jsonb_build_object('portfolio', portfolio_code, 'date', next_roi_date,
                                                       'days', next_roi_date - v_today) from next_payout),
    'next_maturity',       (select jsonb_build_object('portfolio', portfolio_code, 'date', maturity_date,
                                                       'days', maturity_date - v_today) from next_maturity),
    'houses_supported', (
      (select count(*) from public.portfolio_allocations pa
        where pa.portfolio_id in (select id from active) and pa.status in ('reserved', 'fulfilled'))
      + (select count(*) from public.partner_supported_houses psh
          where psh.partner_id = v_uid and psh.status = 'active')),
    'agreement', (select jsonb_build_object(
        'status',            agr.status,
        'agreement_date',    agr.agreement_date,
        'countersigned_on',  (agr.countersigned_at at time zone 'Africa/Kampala')::date,
        'partnership_amount', agr.partnership_amount,
        'payout_mode',       agr.payout_mode,
        'return_option',     agr.return_option,
        'managed_by_company', coalesce(agr.support_mode = 'company_managed', false),
        'payout_destination', case
            when agr.payout_mode = 'momo' then jsonb_build_object(
                 'method', 'mobile money', 'network', agr.momo_provider,
                 'name', agr.momo_name, 'number', public.assistant_mask_tail(agr.momo_number))
            else jsonb_build_object(
                 'method', 'bank', 'bank', agr.bank_name,
                 'name', agr.bank_account_name, 'number', public.assistant_mask_tail(agr.bank_account_number)) end)
        from agr),
    'agreement_acceptance', (select jsonb_build_object(
        'version', accepted.agreement_version, 'accepted_on', (accepted.accepted_at at time zone 'Africa/Kampala')::date,
        'status', accepted.status) from accepted)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.assistant_partner_overview() from public, anon;
grant  execute on function public.assistant_partner_overview() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- One portfolio: reversed renewals and reversed / cancelled top-ups are left out
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Returns by month: what landed in the wallet uses the customer-visibility rule
-- ---------------------------------------------------------------------------

create or replace function public.assistant_partner_returns(
  p_from date default null,
  p_to   date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_to    date;
  v_from  date;
  v_result jsonb;
begin
  perform public.assistant_require_partner();

  v_to   := coalesce(p_to, v_today);
  v_from := coalesce(p_from, (date_trunc('month', v_to) - interval '5 months')::date);
  if v_from > v_to or v_to > v_today or v_to - v_from > 800 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  with mine as (
    select ip.id from public.investor_portfolios ip where ip.investor_id = v_uid and ip.status <> 'cancelled'
  ), earned as (
    -- Net of ledger reversals: a reversed payout must not count as earned. No reversal is listed.
    select to_char(gl.created_at at time zone 'Africa/Kampala', 'YYYY-MM') as month,
           sum(case when gl.direction = 'cash_out' then gl.amount else -gl.amount end) as amt
      from public.general_ledger gl
     where gl.category = 'roi_expense' and gl.ledger_scope = 'platform'
       and gl.source_table = 'investor_portfolios' and gl.source_id in (select id from mine)
       and (gl.created_at at time zone 'Africa/Kampala')::date between v_from and v_to
     group by 1
  ), credited as (
    select to_char(gl.created_at at time zone 'Africa/Kampala', 'YYYY-MM') as month, sum(gl.amount) as amt
      from public.general_ledger gl
     where gl.user_id = v_uid and gl.ledger_scope = 'wallet' and gl.category = 'roi_wallet_credit'
       and gl.direction = 'cash_in'
       and public.is_customer_wallet_history_visible(
             gl.user_id, gl.classification, gl.category, gl.source_table, gl.description, gl.reference_id, gl.source_id)
       and (gl.created_at at time zone 'Africa/Kampala')::date between v_from and v_to
     group by 1
  ), months as (
    select month from earned union select month from credited
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'total_earned',  (select coalesce(round(sum(amt)), 0) from earned),
    'total_credited_to_my_wallet', (select coalesce(round(sum(amt)), 0) from credited),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
               'month', m.month,
               'earned', coalesce((select round(e.amt) from earned e where e.month = m.month), 0),
               'credited_to_my_wallet', coalesce((select round(c.amt) from credited c where c.month = m.month), 0))
             order by m.month desc)
        from months m), '[]'::jsonb),
    'note', 'Earned is the Returns accrued on the portfolios; credited is what landed in this wallet. Partners managed through an agent are paid via that agent, so credited can be lower.'
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.assistant_partner_returns(date, date) from public, anon;
grant  execute on function public.assistant_partner_returns(date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Withdrawals: only the stage is returned, never the internal status text
-- ---------------------------------------------------------------------------

create or replace function public.assistant_partner_withdrawals(
  p_status text default null,
  p_from   date default null,
  p_to     date default null,
  p_limit  integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_today  date := (now() at time zone 'Africa/Kampala')::date;
  v_status text := lower(nullif(btrim(coalesce(p_status, '')), ''));
  v_to     date := coalesce(p_to, v_today);
  v_from   date := coalesce(p_from, v_today - 90);
  v_limit  integer := least(greatest(coalesce(p_limit, 15), 1), 40);
  v_result jsonb;
begin
  perform public.assistant_require_partner();

  if v_status is not null and v_status not in ('all', 'paid', 'in_progress', 'rejected', 'cancelled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if v_from > v_to or v_to > v_today or v_to - v_from > 800 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  with w as (
    select wr.*,
           case when wr.status in ('completed', 'paid') then 'paid'
                when wr.status in ('rejected') then 'rejected'
                when wr.status in ('cancelled', 'expired', 'failed') then 'cancelled'
                else 'in_progress' end as stage
      from public.withdrawal_requests wr
     where wr.user_id = v_uid
       and (wr.created_at at time zone 'Africa/Kampala')::date between v_from and v_to
  ), f as (
    select * from w where v_status is null or v_status = 'all' or stage = v_status
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to, 'status_filter', coalesce(v_status, 'all'),
    'summary', jsonb_build_object(
      'paid_count',        (select count(*) from w where stage = 'paid'),
      'paid_total',        (select coalesce(sum(amount), 0) from w where stage = 'paid'),
      'in_progress_count', (select count(*) from w where stage = 'in_progress'),
      'in_progress_total', (select coalesce(sum(amount), 0) from w where stage = 'in_progress'),
      'rejected_count',    (select count(*) from w where stage = 'rejected'),
      'cancelled_count',   (select count(*) from w where stage = 'cancelled')),
    'total_matching', (select count(*) from f),
    'items', coalesce((
      select jsonb_agg(x order by ord desc) from (
        select f.created_at as ord,
               jsonb_build_object(
                 'requested_on', (f.created_at at time zone 'Africa/Kampala')::date,
                 'amount', f.amount,
                 'stage', f.stage,
                 'paid_on', case when f.stage = 'paid' then (f.processed_at at time zone 'Africa/Kampala')::date end,
                 'method', coalesce(f.payout_method, case when f.mobile_money_provider is not null then 'mobile money' end),
                 'network', f.mobile_money_provider,
                 'bank', f.bank_name,
                 'sent_to', coalesce(public.assistant_mask_tail(f.mobile_money_number), public.assistant_mask_tail(f.bank_account_number)),
                 'for_portfolio_payout', (f.payout_route_ref like 'portfolio:%'),
                 'reference', f.fin_ops_reference) as x
          from f order by f.created_at desc limit v_limit) s), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.assistant_partner_withdrawals(text, date, date, integer) from public, anon;
grant  execute on function public.assistant_partner_withdrawals(text, date, date, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Top-ups: reversed (audit trail) and cancelled operations are left out
-- ---------------------------------------------------------------------------

create or replace function public.assistant_partner_topups(
  p_limit integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 15), 1), 40);
  v_result jsonb;
begin
  perform public.assistant_require_partner();

  with mine as (
    select ip.id, ip.portfolio_code from public.investor_portfolios ip
     where ip.investor_id = v_uid and ip.status <> 'cancelled'
  ), ops as (
    select o.created_at, o.amount, o.status, m.portfolio_code, o.metadata ->> 'fund_source' as fund_source
      from public.pending_wallet_operations o
      join mine m on m.id = o.source_id
     where o.operation_type = 'portfolio_topup' and o.source_table = 'investor_portfolios'
       and o.status in ('completed', 'approved', 'pending', 'processing', 'rejected')
       and not exists (
             select 1 from public.audit_logs ra
              where ra.table_name = 'investor_portfolios' and ra.record_id = o.source_id::text
                and ra.action_type in ('reverse_merged_topup_row', 'revert_premature_topup_merge')
                and ra.metadata ->> 'op_id' = o.id::text)
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'applied_count',  (select count(*) from ops where status in ('completed', 'approved')),
      'applied_total',  (select coalesce(sum(amount), 0) from ops where status in ('completed', 'approved')),
      'rejected_count', (select count(*) from ops where status = 'rejected'),
      'last_topup_on',  (select (max(created_at) at time zone 'Africa/Kampala')::date from ops where status in ('completed', 'approved'))),
    'items', coalesce((
      select jsonb_agg(x order by ord desc) from (
        select o.created_at as ord,
               jsonb_build_object(
                 'date', (o.created_at at time zone 'Africa/Kampala')::date,
                 'amount', o.amount, 'status', o.status,
                 'portfolio', o.portfolio_code, 'paid_from', o.fund_source) as x
          from ops o order by o.created_at desc limit v_limit) s), '[]'::jsonb),
    'company_managed_topups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', (t.created_at at time zone 'Africa/Kampala')::date, 'amount', t.amount, 'status', t.status) order by t.created_at desc)
        from (select * from public.partner_self_topups pt
               where pt.partner_id = v_uid and pt.status <> 'cancelled'
               order by pt.created_at desc limit 10) t), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.assistant_partner_topups(integer) from public, anon;
grant  execute on function public.assistant_partner_topups(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Wallet activity: partner-facing entries only
-- ---------------------------------------------------------------------------

create or replace function public.assistant_partner_wallet_activity(
  p_from      date default null,
  p_to        date default null,
  p_direction text default null,
  p_limit     integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_today  date := (now() at time zone 'Africa/Kampala')::date;
  v_to     date := coalesce(p_to, v_today);
  v_from   date := coalesce(p_from, coalesce(p_to, v_today) - 29);
  v_dir    text := lower(nullif(btrim(coalesce(p_direction, '')), ''));
  v_limit  integer := least(greatest(coalesce(p_limit, 20), 1), 40);
  v_result jsonb;
begin
  perform public.assistant_require_partner();

  if v_dir is not null and v_dir not in ('in', 'out') then
    raise exception 'invalid_direction' using errcode = '22023';
  end if;
  if v_from > v_to or v_to > v_today or v_to - v_from > 366 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  with shown as (
    select coalesce(gl.transaction_date, gl.created_at) as occurred,
           gl.amount,
           case gl.direction when 'cash_in' then 'in' else 'out' end as dir,
           case gl.category
             when 'roi_wallet_credit'      then 'Returns credited to wallet'
             when 'roi_payout'             then 'Returns payout'
             when 'wallet_withdrawal'      then 'Withdrawal'
             when 'wallet_deposit'         then 'Deposit'
             when 'deposit'                then 'Deposit'
             when 'partner_funding'        then 'Portfolio funding or top-up'
             when 'wallet_transfer'        then 'Wallet transfer'
             when 'supporter_rent_fund'    then 'House support'
             when 'angel_pool_investment'  then 'Pool investment'
             when 'referral_bonus'         then 'Referral bonus'
             when 'partner_commission'     then 'Partner commission'
             when 'agent_commission'       then 'Commission earned'
             when 'agent_commission_earned' then 'Commission earned'
           end as kind
      from public.general_ledger gl
     where gl.user_id = v_uid
       and gl.ledger_scope = 'wallet'
       -- Allowlist: a category not named here (every correction, reversal, reclassification and
       -- reconciliation kind, and any new one) is never shown. Funding back INTO the wallet is
       -- left out because it is how a reversed top-up appears.
       and gl.category in ('roi_wallet_credit', 'roi_payout', 'wallet_withdrawal', 'wallet_deposit', 'deposit',
                           'partner_funding', 'wallet_transfer', 'supporter_rent_fund', 'angel_pool_investment',
                           'referral_bonus', 'partner_commission', 'agent_commission', 'agent_commission_earned')
       and not (gl.category = 'partner_funding' and gl.direction = 'cash_in')
       and coalesce(gl.classification, 'production') in ('production', 'legacy_real')
       and public.is_customer_wallet_history_visible(
             gl.user_id, gl.classification, gl.category, gl.source_table, gl.description, gl.reference_id, gl.source_id)
       and lower(coalesce(gl.description, '')) !~ '(revers|correct|adjust|erroneous|reconcil|rollback)'
       and (coalesce(gl.transaction_date, gl.created_at) at time zone 'Africa/Kampala')::date between v_from and v_to
  ), f as (
    select * from shown where v_dir is null or dir = v_dir
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to, 'direction_filter', coalesce(v_dir, 'all'),
    'summary', jsonb_build_object(
      'money_in',  (select coalesce(sum(amount), 0) from shown where dir = 'in'),
      'money_out', (select coalesce(sum(amount), 0) from shown where dir = 'out'),
      'entries',   (select count(*) from shown)),
    'total_matching', (select count(*) from f),
    'items', coalesce((
      select jsonb_agg(x order by ord desc) from (
        select f.occurred as ord,
               jsonb_build_object(
                 'date', (f.occurred at time zone 'Africa/Kampala')::date,
                 'amount', f.amount, 'direction', f.dir, 'type', f.kind) as x
          from f order by f.occurred desc limit v_limit) s), '[]'::jsonb),
    'note', 'This lists partner-facing wallet activity only. It is not a full ledger and may not add up to the balance.'
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.assistant_partner_wallet_activity(date, date, text, integer) from public, anon;
grant  execute on function public.assistant_partner_wallet_activity(date, date, text, integer) to authenticated, service_role;
