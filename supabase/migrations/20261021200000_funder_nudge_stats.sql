-- Funder/partner dashboard nudges: the numbers behind the toasts.
--
-- The copy lives in src/lib/funderNudges/nudges.json; this returns, for the
-- signed-in partner only, every figure those messages may quote, in one
-- read-only call. Field meanings match FunderNudgeStats in
-- src/lib/funderNudges/index.ts.
--
-- Isolation: every row read is keyed to the caller. Portfolios by
-- investor_portfolios.investor_id, ledger rows by user_id or by source_id in
-- the caller's own portfolios, houses by the caller's portfolios (or
-- partner_supported_houses.partner_id), wallet by user_id, invites by
-- created_by. No tenant, agent, landlord or other partner data is returned:
-- only counts and amounts about the caller's own money. The public wrapper takes
-- no arguments and always uses auth.uid(); the internal function is closed to
-- every API role.
--
-- Bases (Kampala calendar day throughout):
--   * Active portfolios: status = 'active'. Principal: investment_amount.
--   * Returns: net roi_expense legs whose source_id is one of the caller's
--     portfolios (payout and compounding alike). total_roi_earned on the
--     portfolio is not maintained (reads 0), so it is not used.
--   * "Landed in your wallet": roi_wallet_credit cash_in on the caller's own
--     wallet. Returns routed to a proxy agent's wallet are not counted, so a
--     managed partner never sees "landed in your wallet" for money they didn't get.
--   * Milestone: total Returns crossed 1m/5m/10m/25m/50m/100m/250m/500m/1bn
--     UGX in the last 7 days.
--   * Next payout date: soonest next_roi_date on an active non-compounding
--     portfolio. No amount: the monthly figure is prorated and varies, and
--     nudges never promise a future amount.
--   * Compounding growth: the active compounding portfolio with the most
--     roi_reinvestment; current = investment_amount, start = current - growth.
--   * Houses supported: live portfolio_allocations (reserved/fulfilled) on the
--     caller's active portfolios plus active partner_supported_houses rows.
--     These are homes held for the partner, not necessarily tenanted.
--   * landlord_rent_paid: no per-partner source exists (a claim moves no
--     money), so it is always null and that nudge never fires.
--   * Supporter since: the caller's first non-cancelled portfolio.
--   * Wallet: withdrawable from wallet_balances_projection; idle days since
--     the caller's last wallet ledger row.

CREATE OR REPLACE FUNCTION public._funder_nudge_stats(p_partner_id uuid, p_day date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with
bounds as (
  select (p_day::timestamp at time zone 'Africa/Kampala')                                as t0,
         ((p_day + 1)::timestamp at time zone 'Africa/Kampala')                          as t1,
         (date_trunc('month', p_day)::timestamp at time zone 'Africa/Kampala')           as month0,
         ((p_day - 6)::timestamp at time zone 'Africa/Kampala')                          as week0
),
mine as (
  select ip.id, ip.portfolio_code, ip.status, ip.roi_mode, ip.investment_amount,
         ip.next_roi_date, ip.maturity_date, ip.created_at
  from investor_portfolios ip
  where ip.investor_id = p_partner_id
    and ip.status <> 'cancelled'
),
active as (select * from mine where status = 'active'),
returns as (
  select gl.source_id as portfolio_id, gl.created_at,
         case when gl.direction = 'cash_out' then gl.amount else -gl.amount end as amt
  from general_ledger gl
  where gl.category = 'roi_expense'
    and gl.ledger_scope = 'platform'
    and gl.source_table = 'investor_portfolios'
    and gl.source_id in (select id from mine)
),
totals as (
  select coalesce(sum(r.amt), 0)                                        as total_now,
         coalesce(sum(r.amt) filter (where r.created_at < b.week0), 0)  as total_week_ago,
         coalesce(sum(r.amt) filter (where r.created_at >= b.month0), 0) as this_month
  from returns r cross join bounds b
),
milestone as (
  select exists (
    select 1 from unnest(array[1e6, 5e6, 1e7, 2.5e7, 5e7, 1e8, 2.5e8, 5e8, 1e9]::numeric[]) m, totals t
    where t.total_week_ago < m and t.total_now >= m
  ) as reached
),
wallet_credit as (
  select gl.amount, gl.created_at
  from general_ledger gl
  where gl.user_id = p_partner_id
    and gl.ledger_scope = 'wallet'
    and gl.category = 'roi_wallet_credit'
    and gl.direction = 'cash_in'
  order by gl.created_at desc
  limit 1
),
next_payout as (
  select a.next_roi_date
  from active a
  where a.roi_mode not in ('monthly_compounding', 'compound')
    and a.next_roi_date >= p_day
  order by a.next_roi_date
  limit 1
),
maturing as (
  select a.portfolio_code, a.maturity_date
  from active a
  where a.maturity_date >= p_day
  order by a.maturity_date, a.portfolio_code
  limit 1
),
growth as (
  select a.portfolio_code, a.investment_amount,
         (select coalesce(sum(case when gl.direction = 'cash_in' then gl.amount else -gl.amount end), 0)
            from general_ledger gl
           where gl.category = 'roi_reinvestment'
             and gl.source_table = 'investor_portfolios'
             and gl.source_id = a.id) as grown
  from active a
  where a.roi_mode in ('monthly_compounding', 'compound')
),
top_growth as (select * from growth where grown > 0 order by grown desc, portfolio_code limit 1),
houses as (
  select
    (select count(*) from portfolio_allocations pa
      where pa.portfolio_id in (select id from active)
        and pa.status in ('reserved', 'fulfilled'))
    + (select count(*) from partner_supported_houses psh
        where psh.partner_id = p_partner_id and psh.status = 'active') as n
),
since as (
  select (min(created_at) at time zone 'Africa/Kampala')::date as first_day from mine
),
wallet as (
  select wbp.withdrawable from wallet_balances_projection wbp where wbp.user_id = p_partner_id
),
wallet_last as (
  select max(gl.created_at) as last_at
  from general_ledger gl
  where gl.user_id = p_partner_id and gl.ledger_scope = 'wallet'
)
select jsonb_build_object(
  'first_name',                (select nullif(split_part(trim(p.full_name), ' ', 1), '') from profiles p where p.id = p_partner_id),
  'active_portfolios',         (select count(*) from active),
  'total_principal',           (select coalesce(sum(investment_amount), 0) from active),
  'next_payout_date',          (select next_roi_date from next_payout),
  'days_to_next_payout',       (select next_roi_date - p_day from next_payout),
  'returns_last_amount',       (select round(amount) from wallet_credit),
  'hours_since_last_returns',  (select floor(extract(epoch from (now() - created_at)) / 3600) from wallet_credit),
  'total_returns_received',    (select round(total_now) from totals),
  'returns_milestone_reached', (select case when reached then 1 else 0 end from milestone),
  'returns_this_month',        (select round(this_month) from totals),
  'portfolio_label',           (select portfolio_code from maturing),
  'maturity_date',             (select maturity_date from maturing),
  'days_to_maturity',          (select maturity_date - p_day from maturing),
  'is_compounding',            case when exists (select 1 from top_growth) then 1 else 0 end,
  'growth_portfolio_label',    (select portfolio_code from top_growth),
  'start_amount',              (select round(investment_amount - grown) from top_growth),
  'current_value',             (select round(investment_amount) from top_growth),
  'growth_amount',             (select round(grown) from top_growth),
  'houses_supported',          (select n from houses),
  'landlord_rent_paid',        null,
  'days_as_supporter',         (select p_day - first_day from since),
  'years_as_supporter',        (select extract(year from age(p_day, first_day))::int from since),
  'is_anniversary_today',      (select case when first_day < p_day
                                              and extract(month from first_day) = extract(month from p_day)
                                              and extract(day from first_day) = extract(day from p_day)
                                            then 1 else 0 end from since),
  'wallet_balance',            (select round(withdrawable) from wallet),
  'wallet_idle_days',          (select (p_day - (last_at at time zone 'Africa/Kampala')::date) from wallet_last),
  'referrals_30d',             (select count(*) from supporter_invites si
                                 where si.created_by = p_partner_id
                                   and si.created_at >= (select t1 from bounds) - interval '30 days')
);
$function$;

CREATE OR REPLACE FUNCTION public.get_funder_nudge_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = '28000';
  END IF;
  RETURN public._funder_nudge_stats(auth.uid(), (now() AT TIME ZONE 'Africa/Kampala')::date);
END
$function$;

REVOKE ALL ON FUNCTION public._funder_nudge_stats(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_funder_nudge_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_funder_nudge_stats() TO authenticated;
