-- One definition of the Liquidity Forecast, for the web panel and the mobile app to share.
--
-- Until now each client worked the forecast out for itself and they disagreed:
--   * withdrawable now: web summed wallets.withdrawable_balance; the app read the ledger-based cache (get_wallet_totals).
--   * ROI days: the mobile app rolls Saturday and Sunday ROI onto Monday (we do not pay partner rewards over the weekend);
--     the web grouped by the raw due date.
--   * day boundaries: the app used Kampala days; the web used UTC.
--
-- get_liquidity_forecast(p_days) returns everything in one read-only call, using one set of rules:
--   * "today" and every day bucket are Africa/Kampala days.
--   * ROI that falls due on a Saturday or Sunday is counted on the Monday after (Sat + Sun + Mon together). On a Monday
--     the weekend's ROI is therefore part of today. A window that ends on a weekend runs on to that Monday.
--   * ROI amount = investment_amount * roi_percentage / 100, rounded; auto_reinvest or compounding means no cash leaves.
--   * withdrawable now = the sum of wallets.withdrawable_balance (what a user can actually withdraw). The ledger-based
--     figure from wallet_totals_cache is returned alongside, with the gap, so a difference is visible rather than hidden.
--   * overdue landlord payouts are split into recent (past SLA up to 30 days) and stale (older than 30 days), so a pile of
--     old unsettled rows no longer makes today's backlog look enormous. Both are always returned.
--
-- Read-only. Finance roles only. Roll back with 20261005150000_liquidity_forecast_single_source.rollback.sql.

CREATE OR REPLACE FUNCTION public.get_liquidity_forecast(p_days integer DEFAULT 14)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 14), 1), 90);
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date;
  v_roi_end date;
  v_lp_start timestamptz;
  v_lp_end timestamptz;
  v_pending_lp text[] := ARRAY['pending_merchant_payout','awaiting_agent_receipt','failed','pending','queued'];
  v_out jsonb;
BEGIN
  IF NOT (public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'manager')
          OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'ceo') OR public.has_role(v_uid, 'coo')
          OR public.has_role(v_uid, 'cto')) THEN
    RAISE EXCEPTION 'The liquidity forecast is only visible to finance roles';
  END IF;

  v_to := v_today + v_days;
  -- A window ending on Saturday or Sunday runs on to the Monday its ROI is paid.
  v_roi_end := v_to + CASE extract(isodow FROM v_to)::int WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END;
  v_lp_start := v_today::timestamp AT TIME ZONE 'Africa/Kampala';
  v_lp_end := (v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala';

  WITH roi AS (
    SELECT
      p.next_roi_date AS due_date,
      p.next_roi_date + CASE extract(isodow FROM p.next_roi_date)::int WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END AS pay_date,
      round(COALESCE(p.investment_amount, 0) * COALESCE(p.roi_percentage, 0) / 100) AS amount,
      (p.auto_reinvest IS TRUE OR p.roi_mode = 'compounding') AS reinvest
    FROM public.investor_portfolios p
    WHERE p.status = 'active'
      AND p.next_roi_date IS NOT NULL
      -- two days early so the weekend's ROI is found when today is a Sunday or Monday
      AND p.next_roi_date BETWEEN v_today - 2 AND v_roi_end
  ), roi_days AS (
    SELECT
      pay_date,
      sum(amount) AS total,
      sum(amount) FILTER (WHERE NOT reinvest) AS cashout,
      sum(amount) FILTER (WHERE reinvest) AS reinvest,
      sum(amount) FILTER (WHERE due_date <> pay_date) AS rolled_from_weekend,
      count(*) AS portfolios
    FROM roi
    WHERE pay_date BETWEEN v_today AND v_roi_end
    GROUP BY pay_date
  ), lp_days AS (
    SELECT
      (lp.sla_deadline AT TIME ZONE 'Africa/Kampala')::date AS day,
      sum(lp.amount) AS total,
      count(*) AS payouts
    FROM public.landlord_payouts lp
    WHERE lp.status = ANY (v_pending_lp)
      AND lp.sla_deadline >= v_lp_start
      AND lp.sla_deadline < v_lp_end
    GROUP BY 1
  ), overdue AS (
    SELECT
      COALESCE(sum(lp.amount) FILTER (WHERE lp.sla_deadline >= now() - interval '30 days'), 0) AS recent_total,
      count(*) FILTER (WHERE lp.sla_deadline >= now() - interval '30 days') AS recent_count,
      COALESCE(sum(lp.amount) FILTER (WHERE lp.sla_deadline < now() - interval '30 days'), 0) AS stale_total,
      count(*) FILTER (WHERE lp.sla_deadline < now() - interval '30 days') AS stale_count
    FROM public.landlord_payouts lp
    WHERE lp.status = ANY (v_pending_lp) AND lp.sla_deadline < now()
  ), wd AS (
    SELECT COALESCE(sum(w.withdrawable_balance), 0) AS total, count(*) AS wallets
    FROM public.wallets w
    WHERE w.withdrawable_balance > 0
  ), drain AS (
    SELECT COALESCE(sum(r.amount), 0) AS total, count(*) AS n
    FROM public.withdrawal_requests r
    WHERE r.status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')
  ), cache AS (
    SELECT c.total_withdrawable, c.computed_at FROM public.wallet_totals_cache c WHERE c.id = 1
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'today', v_today,
    'window_end', v_to,
    'days', v_days,
    'withdrawable', (SELECT jsonb_build_object(
        'total', wd.total,
        'wallets', wd.wallets,
        'ledger_total', COALESCE((SELECT total_withdrawable FROM cache), 0),
        'ledger_computed_at', (SELECT computed_at FROM cache),
        'gap_vs_ledger', COALESCE((SELECT total_withdrawable FROM cache), 0) - wd.total
      ) FROM wd),
    'pending_withdrawals', (SELECT jsonb_build_object('total', drain.total, 'count', drain.n) FROM drain),
    'overdue_payouts', (SELECT jsonb_build_object(
        'recent_total', recent_total, 'recent_count', recent_count,
        'stale_total', stale_total, 'stale_count', stale_count,
        'total', recent_total + stale_total, 'count', recent_count + stale_count
      ) FROM overdue),
    'roi_days', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'date', pay_date,
        'total', total,
        'cashout', COALESCE(cashout, 0),
        'reinvest', COALESCE(reinvest, 0),
        'rolled_from_weekend', COALESCE(rolled_from_weekend, 0),
        'portfolios', portfolios
      ) ORDER BY pay_date) FROM roi_days), '[]'::jsonb),
    'landlord_payout_days', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'date', day, 'total', total, 'payouts', payouts
      ) ORDER BY day) FROM lp_days), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_liquidity_forecast(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_liquidity_forecast(integer) TO authenticated;

-- Supabase also grants EXECUTE to anon by default; take it away. (The function refuses callers without a finance role
-- either way, this just removes the anonymous entry point.)
REVOKE EXECUTE ON FUNCTION public.get_liquidity_forecast(integer) FROM anon;
