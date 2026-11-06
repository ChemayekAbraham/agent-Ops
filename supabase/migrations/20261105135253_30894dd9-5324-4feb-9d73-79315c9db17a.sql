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
    -- Contract details come from get_partner_contract. Only a plain state is kept here so a missing
    -- partnership-agreement row is never read as "no contract".
    'contract_state', case
        when exists (select 1 from public.partner_agreements pa where pa.partner_id = v_uid and pa.status = 'countersigned') then 'signed_agreement'
        when exists (select 1 from public.partner_agreements pa where pa.partner_id = v_uid) then 'agreement_awaiting_welile_countersignature'
        when exists (select 1 from public.supporter_agreement_acceptance s where s.supporter_id = v_uid and s.status = 'accepted') then 'accepted_terms_online'
        else 'none_on_record' end,
    'contract_note', 'Use get_partner_contract for contract details.'
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.assistant_partner_overview() from public, anon;
grant  execute on function public.assistant_partner_overview() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Contract: everything that makes up the partner's agreement with Welile, in one place
-- ---------------------------------------------------------------------------
-- A partner's contract is three things that live in different tables:
--   * the partnership agreement (partner_agreements), which many older partners never had;
--   * the Welile partner terms they accepted online (supporter_agreement_acceptance), which nearly
--     every partner has;
--   * the terms of each portfolio (rate, duration, mode, amount, dates).
-- A missing partnership agreement must never be reported as "you did not sign anything".

create or replace function public.assistant_partner_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_today  date := (now() at time zone 'Africa/Kampala')::date;
  v_result jsonb;
begin
  perform public.assistant_require_partner();

  with mine as (
    select ip.* from public.investor_portfolios ip
     where ip.investor_id = v_uid and ip.status <> 'cancelled'
  ), agr as (
    select * from public.partner_agreements pa
     where pa.partner_id = v_uid
     order by (pa.status = 'countersigned') desc, pa.created_at desc limit 1
  ), acc as (
    select count(*) as times_accepted,
           min(s.accepted_at) as first_at,
           max(s.accepted_at) as last_at,
           (array_agg(s.agreement_version order by s.accepted_at desc))[1] as version
      from public.supporter_agreement_acceptance s
     where s.supporter_id = v_uid and s.status = 'accepted'
  )
  select jsonb_build_object(
    'state', case
        when exists (select 1 from agr where agr.status = 'countersigned') then 'signed_agreement'
        when exists (select 1 from agr) then 'agreement_awaiting_welile_countersignature'
        when (select times_accepted from acc) > 0 then 'accepted_terms_online'
        else 'none_on_record' end,
    'partnership_agreement', (select jsonb_build_object(
        'status',              agr.status,
        'agreement_date',      agr.agreement_date,
        'partner_signed',      (agr.partner_signature_data_url is not null),
        'countersigned_on',    (agr.countersigned_at at time zone 'Africa/Kampala')::date,
        'signed_copy_on_file', (agr.generated_pdf_path is not null),
        'partnership_amount',  agr.partnership_amount,
        'payout_mode',         agr.payout_mode,
        'return_option',       agr.return_option,
        'managed_by_company',  coalesce(agr.support_mode = 'company_managed', false),
        'payout_destination',  case
            when agr.payout_mode = 'momo' then jsonb_build_object(
                 'method', 'mobile money', 'network', agr.momo_provider,
                 'name', agr.momo_name, 'number', public.assistant_mask_tail(agr.momo_number))
            else jsonb_build_object(
                 'method', 'bank', 'bank', agr.bank_name,
                 'name', agr.bank_account_name, 'number', public.assistant_mask_tail(agr.bank_account_number)) end)
        from agr),
    'accepted_terms', (select jsonb_build_object(
        'version', acc.version,
        'first_accepted_on', (acc.first_at at time zone 'Africa/Kampala')::date,
        'latest_accepted_on', (acc.last_at at time zone 'Africa/Kampala')::date,
        'times_accepted', acc.times_accepted)
        from acc where acc.times_accepted > 0),
    'portfolio_count', (select count(*) from mine),
    'portfolio_terms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', t.portfolio_code,
               'status', t.status,
               'started_on', (t.created_at at time zone 'Africa/Kampala')::date,
               'current_value', t.investment_amount,
               'rate_percent', t.roi_percentage,
               'duration_months', t.duration_months,
               'mode', case when t.roi_mode in ('monthly_compounding', 'compound') then 'compounding' else 'monthly payout' end,
               'maturity_date', t.maturity_date,
               'days_to_maturity', t.maturity_date - v_today)
             order by t.created_at)
        from (select * from mine order by created_at limit 40) t), '[]'::jsonb),
    'note', 'The terms of each portfolio (rate, duration, mode, dates) are the terms in force. A partner without a partnership agreement document has still accepted the Welile partner terms online.'
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.assistant_partner_contract() from public, anon;
grant  execute on function public.assistant_partner_contract() to authenticated, service_role;