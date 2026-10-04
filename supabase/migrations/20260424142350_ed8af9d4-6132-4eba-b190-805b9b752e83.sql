-- 1. Add impact metric columns to daily_platform_stats
ALTER TABLE public.daily_platform_stats
  ADD COLUMN IF NOT EXISTS tenants_impacted_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS agents_earning_30d integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS partners_with_portfolios integer NOT NULL DEFAULT 0;

-- 2. Extend compute_daily_stats to populate the new columns
CREATE OR REPLACE FUNCTION public.compute_daily_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total int;
  v_active int;
  v_new_today int;
  v_referral_count int;
  v_daily_txn numeric;
  v_roles jsonb;
  v_tenants_impacted int;
  v_agents_earning int;
  v_partners_active int;
  v_today date := CURRENT_DATE;
  v_today_start timestamptz := v_today::timestamptz;
  v_30d_ago timestamptz := v_today_start - interval '30 days';
BEGIN
  SELECT count(*) INTO v_total FROM public.profiles;
  SELECT count(*) INTO v_active FROM public.profiles WHERE updated_at >= v_30d_ago;
  SELECT count(*) INTO v_new_today FROM public.profiles WHERE created_at >= v_today_start;
  SELECT count(*) INTO v_referral_count FROM public.profiles WHERE referrer_id IS NOT NULL;
  SELECT COALESCE(sum(amount), 0) INTO v_daily_txn FROM public.general_ledger WHERE transaction_date >= v_today_start;

  SELECT jsonb_object_agg(role, cnt) INTO v_roles
  FROM (SELECT role::text, count(*) as cnt FROM public.user_roles WHERE enabled = true GROUP BY role) sub;

  -- Impact metrics
  SELECT count(DISTINCT tenant_id) INTO v_tenants_impacted
  FROM public.rent_requests
  WHERE status IN ('disbursed', 'repaying', 'completed', 'funded');

  SELECT count(DISTINCT agent_id) INTO v_agents_earning
  FROM public.agent_earnings
  WHERE amount > 0 AND created_at >= v_30d_ago;

  SELECT count(DISTINCT investor_id) INTO v_partners_active
  FROM public.investor_portfolios
  WHERE status = 'active' AND investment_amount > 0;

  INSERT INTO public.daily_platform_stats (
    stat_date, total_users, active_users_30d, new_users_today, retention_pct, referral_pct,
    daily_transaction_volume, users_by_role,
    tenants_impacted_total, agents_earning_30d, partners_with_portfolios, updated_at
  )
  VALUES (
    v_today, v_total, v_active, v_new_today,
    CASE WHEN v_total > 0 THEN round((v_active::numeric / v_total) * 100, 2) ELSE 0 END,
    CASE WHEN v_total > 0 THEN round((v_referral_count::numeric / v_total) * 100, 2) ELSE 0 END,
    v_daily_txn, COALESCE(v_roles, '{}'),
    v_tenants_impacted, v_agents_earning, v_partners_active, now()
  )
  ON CONFLICT (stat_date) DO UPDATE SET
    total_users = EXCLUDED.total_users,
    active_users_30d = EXCLUDED.active_users_30d,
    new_users_today = EXCLUDED.new_users_today,
    retention_pct = EXCLUDED.retention_pct,
    referral_pct = EXCLUDED.referral_pct,
    daily_transaction_volume = EXCLUDED.daily_transaction_volume,
    users_by_role = EXCLUDED.users_by_role,
    tenants_impacted_total = EXCLUDED.tenants_impacted_total,
    agents_earning_30d = EXCLUDED.agents_earning_30d,
    partners_with_portfolios = EXCLUDED.partners_with_portfolios,
    updated_at = now();
END;
$function$;

-- 3. Allow CFO to read stats (existing policy covers manager/ceo/coo only)
DROP POLICY IF EXISTS "CFO can read platform stats" ON public.daily_platform_stats;
CREATE POLICY "CFO can read platform stats"
  ON public.daily_platform_stats
  FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'cfo'::app_role));

-- 4. Backfill today's row immediately
SELECT public.compute_daily_stats();