-- get_partner_ops_recent_withdrawals was hitting the 8s authenticated
-- statement_timeout. EXPLAIN (ANALYZE, BUFFERS) on 2026-10-27, read-only,
-- p_limit 10, inlined the live body:
--   Execution Time 1317 ms
--   investor_portfolios Seq Scan, 10 loops, ~130 ms each, 1609 rows removed
--   regexp_match(reason, 'Route:…') was inlined into that filter and evaluated
--   per portfolio row (three times in the OR), not once per withdrawal
--   withdrawal_requests sort ~9 ms; profiles and proxy laterals ~0.05 ms
-- The same function, called as an ops user and then rolled back: p_limit 10
-- took 1388 ms and p_limit 100 took 13715 ms.
--
-- Same signature, STABLE SECURITY DEFINER, search_path public, role check,
-- 1..100 clamp, jsonb keys and x_ord desc order. The top v_limit withdrawals
-- are materialized first and the two reason captures are computed once.
-- The portfolio lateral is then two mutually exclusive arms:
--   1. primary-key lookup when the narration has a portfolio id
--   2. owner lookup on coalesce(investor_id, agent_id) only when it does not
-- A route id that matches no portfolio stays null. It does not fall through
-- to another portfolio of the same partner.
--
-- Read-only check of that shape: p_limit 100 finished in 12.8 ms (pkey index
-- only scan, owner arm never executed — the current top 100 all carry a route
-- id). After replacing the function inside a transaction that was rolled
-- back, the jsonb matched the old function for p_limit 10 and 100 (and for
-- null, 0 and 1000, which clamp to 10, 1 and 100). Clock time was 11 ms and
-- 16 ms; EXPLAIN (ANALYZE, BUFFERS) of the function call was 24.9 ms and
-- 30.6 ms. All 3,602 partner withdrawals (669 with no route id, 15 with a
-- route id that matches no portfolio) returned the same portfolio id as the
-- old filter. One expression index, measured with EXPLAIN ANALYZE inside a
-- rolled-back transaction: owner lookup became a bitmap index scan, 0.068 ms,
-- and re-checking those 669 rows changed 0 portfolio ids.
--
-- The index is not built CONCURRENTLY. This migration runs in a transaction,
-- and investor_portfolios is about 1,610 rows / 520 kB, so the ShareLock is
-- brief. CONCURRENTLY is the right build if this is ever applied by hand to a
-- much larger table; it cannot run inside this file.
--
-- Apply on byrzshwlentqvktcksem only when this migration is taken on purpose.
-- Do not apply from the branch.

SET lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public.get_partner_ops_recent_withdrawals(integer)') IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), ''))
           FROM pg_proc
          WHERE oid = 'public.get_partner_ops_recent_withdrawals(integer)'::regprocedure)
          IS DISTINCT FROM '07aefce240f13a3e167b2b9a5a52959e' THEN
    RAISE EXCEPTION 'precondition failed: get_partner_ops_recent_withdrawals changed since 2026-10-27; nothing was changed';
  END IF;
END
$pre$;

CREATE INDEX IF NOT EXISTS idx_investor_portfolios_owner
  ON public.investor_portfolios ((coalesce(investor_id, agent_id)));

CREATE OR REPLACE FUNCTION public.get_partner_ops_recent_withdrawals(p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_limit integer := greatest(1, least(100, coalesce(p_limit, 10)));
  v_rows jsonb;
begin
  if not (
    has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'coo') or has_role(auth.uid(), 'ceo')
    or has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'partner_ops') or has_role(auth.uid(), 'financial_ops')
    or has_role(auth.uid(), 'operations')
  ) then
    raise exception 'not authorized';
  end if;

  with top as materialized (
    select
      s.id,
      s.partner_id,
      s.x_ord,
      s.amount,
      s.status,
      s.created_at,
      s.mobile_money_name,
      s.bank_account_name,
      (regexp_match(coalesce(s.reason, ''), 'Portfolio:\s*([^|;\n]+)'))[1] as narration_portfolio,
      (regexp_match(coalesce(s.reason, ''), 'Route:\s*portfolio\s+([0-9a-fA-F-]{36})'))[1]::uuid as narration_portfolio_id
    from (
      select
        w.id,
        coalesce(w.linked_party, w.proxy_partner_id) as partner_id,
        coalesce(w.processed_at, w.fin_ops_approved_at, w.cfo_approved_at,
                 w.coo_approved_at, w.manager_approved_at, w.created_at) as x_ord,
        w.amount,
        w.status,
        w.created_at,
        w.mobile_money_name,
        w.bank_account_name,
        w.reason
      from withdrawal_requests w
      where w.linked_party is not null or w.proxy_partner_id is not null
      order by x_ord desc
      limit v_limit
    ) s
  )
  select coalesce(jsonb_agg(x order by x_ord desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
             'id', w.id,
             'partner_id', w.partner_id,
             'partner_name', coalesce(pr.full_name, pr.email, w.mobile_money_name, w.bank_account_name, 'Unknown partner'),
             'amount', coalesce(w.amount, 0),
             'status', w.status,
             'requested_at', w.created_at,
             'processing_date', w.x_ord,
             'portfolio_code', ip.portfolio_code,
             'portfolio_name', coalesce(nullif(w.narration_portfolio, ''), ip.account_name),
             'portfolio_id', ip.id,
             'roi_percentage', ip.roi_percentage,
             'roi_amount', case when ip.investment_amount is not null and ip.roi_percentage is not null
                                then round(ip.investment_amount * ip.roi_percentage / 100.0) end,
             'proxy_agent_name', px.proxy_name,
             'proxy_managed', px.is_managed_account
           ) as x,
           w.x_ord
    from top w
    left join profiles pr on pr.id = w.partner_id
    left join lateral (
      select u.id, u.portfolio_code, u.account_name, u.investment_amount, u.roi_percentage
      from (
        (
          select p.id, p.portfolio_code, p.account_name, p.investment_amount, p.roi_percentage
          from investor_portfolios p
          where p.id = w.narration_portfolio_id
        )
        union all
        (
          select p.id, p.portfolio_code, p.account_name, p.investment_amount, p.roi_percentage
          from investor_portfolios p
          where w.narration_portfolio_id is null
            and coalesce(p.investor_id, p.agent_id) = w.partner_id
          order by (p.status = 'active') desc, p.investment_amount desc nulls last, p.created_at desc
          limit 1
        )
      ) u
      limit 1
    ) ip on true
    left join lateral (
      select coalesce(ap.full_name, ap.email) as proxy_name, a.is_managed_account
      from proxy_agent_assignments a
      left join profiles ap on ap.id = a.agent_id
      where a.beneficiary_id = w.partner_id
        and a.is_active = true
        and coalesce(a.approval_status, 'approved') = 'approved'
      order by a.is_managed_account desc nulls last, a.created_at desc
      limit 1
    ) px on true
  ) q;

  return jsonb_build_object('rows', v_rows);
end;
$function$;

-- Live EXECUTE is postgres, authenticated and service_role. CREATE OR REPLACE
-- keeps that ACL. Re-state it, and keep PUBLIC / anon closed, so a later edit
-- that drops and recreates the function does not inherit the default anon grant.
REVOKE ALL ON FUNCTION public.get_partner_ops_recent_withdrawals(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_partner_ops_recent_withdrawals(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_partner_ops_recent_withdrawals(integer) TO authenticated, service_role, postgres;
