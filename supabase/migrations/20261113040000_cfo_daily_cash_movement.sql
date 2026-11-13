-- CFO Cash Position chart: real money received and paid out per day (CFO request, 11 Nov 2026).
--
-- The chart used get_cfo_daily_cash_flow, which adds up EVERY ledger leg (wallet, platform and bridge, both sides of
-- every entry). That is a gross volume figure, not cash: each movement is counted at least twice, and accounting-only
-- correction entries (dated to the original transactions) showed up as money received. get_cfo_daily_cash_flow is left
-- unchanged because the Transaction Totals screen uses it on purpose as gross volume, with its own breakdown.
--
-- This function measures cash on the Treasury card basis (get_treasury_cash_position: base ledger mapping, production +
-- legacy_real legs and merchant float reconciliations), for the company's cash accounts as listed in fin_cash_accounts
-- (A1 cash and bank, A5 cash collected not yet banked, A21/A22 landlord float pool):
--   * each ledger group's cash effect on a Kampala day is the net of its legs on those accounts, so moves between cash
--     accounts (banking custody cash, earmarking to the landlord pool) cancel out and are neither received nor paid;
--   * a group with a net increase is money received, a net decrease is money paid out;
--   * accounting corrections (groups in money_in_report_exclusions, the acct_corr_* batches and the reclassification keys
--     already excluded from Money In) moved no money that day: their net effect is returned separately in `corrections`.
-- received - paid + corrections over a window equals the change in the Treasury card's cash including the landlord pool.
--
-- Read-only. Rollback: supabase/rollbacks/20261113040000_cfo_daily_cash_movement.rollback.sql

create or replace function public.get_cfo_daily_cash_movement(p_days integer default 30)
returns table(day date, inflow numeric, outflow numeric, corrections numeric)
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_uid uuid := auth.uid();
  v_days integer := greatest(1, least(coalesce(p_days, 30), 90));
  v_end date := (now() at time zone 'Africa/Kampala')::date;
  v_start date := ((now() at time zone 'Africa/Kampala')::date - (greatest(1, least(coalesce(p_days, 30), 90)) - 1));
begin
  if v_uid is null or not (
    public.has_role(v_uid, 'cfo') or public.has_role(v_uid, 'ceo') or public.has_role(v_uid, 'coo')
    or public.has_role(v_uid, 'manager') or public.has_role(v_uid, 'financial_ops') or public.has_role(v_uid, 'super_admin')
  ) then
    raise exception 'Not authorized';
  end if;

  return query
  with days as (
    select generate_series(v_start, v_end, interval '1 day')::date as d
  ), legs as materialized (
    select coalesce(gl.transaction_group_id, gl.id) as gid,
           (gl.transaction_date at time zone 'Africa/Kampala')::date as d,
           gl.direction, gl.amount, gl.idempotency_key,
           coalesce(mb.account_code, mw.account_code,
             case when gl.ledger_scope = 'wallet' and gl.wallet_bucket = 'float'   then 'A2'
                  when gl.ledger_scope = 'wallet' and gl.wallet_bucket = 'advance' then 'A4'
                  when gl.ledger_scope = 'wallet'                                  then 'L1'
                  else 'A9' end) as account_code,
           coalesce(mb.debit_when, mw.debit_when,
             case when gl.ledger_scope = 'wallet' and gl.wallet_bucket in ('float', 'advance') then 'cash_in'
                  when gl.ledger_scope = 'wallet'                                               then 'cash_out'
                  else 'cash_in' end) as debit_when
    from public.general_ledger gl
    left join public.ledger_account_map mb
           on mb.ledger_scope = gl.ledger_scope and mb.category = gl.category
          and mb.wallet_bucket is not null and mb.wallet_bucket = gl.wallet_bucket
    left join public.ledger_account_map mw
           on mw.ledger_scope = gl.ledger_scope and mw.category = gl.category and mw.wallet_bucket is null
    where (gl.classification in ('production', 'legacy_real')
             or (gl.classification = 'admin_correction' and gl.source_table = 'merchant_float_reconciliations'))
      and gl.transaction_date >= (v_start::timestamp at time zone 'Africa/Kampala')
      and gl.transaction_date <  ((v_end + 1)::timestamp at time zone 'Africa/Kampala')
  ), grp as (
    select l.d, l.gid,
           sum(case when l.direction = l.debit_when then l.amount else -l.amount end)
             filter (where l.account_code in (select c.code from public.fin_cash_accounts c where c.included)) as eff,
           bool_or(coalesce(l.idempotency_key, '') like 'acct\_corr\_%'
                or left(coalesce(l.idempotency_key, ''), 30) = 'smartphone_a10_to_a12_reclass:'
                or left(coalesce(l.idempotency_key, ''), 34) = 'merch_a12_a13_correction_20261104:'
                or left(coalesce(l.idempotency_key, ''), 19) = 'merch_recv_derecog:') as corr_key
    from legs l
    group by l.d, l.gid
  ), flagged as (
    select g.d, g.eff,
           (g.corr_key or exists (select 1 from public.money_in_report_exclusions x where x.transaction_group_id = g.gid)) as is_corr
    from grp g
    where g.eff is not null and g.eff <> 0
  )
  select dd.d,
         coalesce(sum(f.eff) filter (where not f.is_corr and f.eff > 0), 0)::numeric,
         coalesce(-sum(f.eff) filter (where not f.is_corr and f.eff < 0), 0)::numeric,
         coalesce(sum(f.eff) filter (where f.is_corr), 0)::numeric
  from days dd
  left join flagged f on f.d = dd.d
  group by dd.d
  order by dd.d;
end;
$function$;

comment on function public.get_cfo_daily_cash_movement(integer) is
  'CFO Cash Position chart: money received / paid out per Kampala day on the Treasury card basis (A1, A5, A21, A22 via fin_cash_accounts); moves between cash accounts cancel; accounting corrections returned separately. Read-only.';

revoke all on function public.get_cfo_daily_cash_movement(integer) from public, anon;
grant execute on function public.get_cfo_daily_cash_movement(integer) to authenticated, service_role;
