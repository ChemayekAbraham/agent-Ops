ALTER TABLE public.daily_platform_stats
  ADD COLUMN IF NOT EXISTS landlords_active_90d integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS landlords_dormant integer NOT NULL DEFAULT 0;

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
  v_landlords_active int;
  v_landlords_dormant int;
  v_today date := CURRENT_DATE;
  v_today_start timestamptz := v_today::timestamptz;
  v_30d_ago timestamptz := v_today_start - interval '30 days';
  v_90d_ago timestamptz := v_today_start - interval '90 days';
BEGIN
  SELECT count(*) INTO v_total FROM public.profiles;
  SELECT count(*) INTO v_active FROM public.profiles WHERE updated_at >= v_30d_ago;
  SELECT count(*) INTO v_new_today FROM public.profiles WHERE created_at >= v_today_start;
  SELECT count(*) INTO v_referral_count FROM public.profiles WHERE referrer_id IS NOT NULL;
  SELECT COALESCE(sum(amount), 0) INTO v_daily_txn FROM public.general_ledger WHERE transaction_date >= v_today_start;

  SELECT jsonb_object_agg(role, cnt) INTO v_roles
  FROM (SELECT role::text, count(*) as cnt FROM public.user_roles WHERE enabled = true GROUP BY role) sub;

  SELECT count(DISTINCT tenant_id) INTO v_tenants_impacted
  FROM public.rent_requests
  WHERE status IN ('disbursed', 'repaying', 'completed', 'funded');

  SELECT count(DISTINCT agent_id) INTO v_agents_earning
  FROM public.agent_earnings
  WHERE amount > 0 AND created_at >= v_30d_ago;

  SELECT count(DISTINCT investor_id) INTO v_partners_active
  FROM public.investor_portfolios
  WHERE status = 'active' AND investment_amount > 0;

  SELECT
    count(*) FILTER (WHERE rent_last_paid_at >= v_90d_ago),
    count(*) FILTER (WHERE rent_last_paid_at IS NULL OR rent_last_paid_at < v_90d_ago)
  INTO v_landlords_active, v_landlords_dormant
  FROM public.landlords;

  INSERT INTO public.daily_platform_stats (
    stat_date, total_users, active_users_30d, new_users_today, retention_pct, referral_pct,
    daily_transaction_volume, users_by_role,
    tenants_impacted_total, agents_earning_30d, partners_with_portfolios,
    landlords_active_90d, landlords_dormant, updated_at
  )
  VALUES (
    v_today, v_total, v_active, v_new_today,
    CASE WHEN v_total > 0 THEN round((v_active::numeric / v_total) * 100, 2) ELSE 0 END,
    CASE WHEN v_total > 0 THEN round((v_referral_count::numeric / v_total) * 100, 2) ELSE 0 END,
    v_daily_txn, COALESCE(v_roles, '{}'),
    v_tenants_impacted, v_agents_earning, v_partners_active,
    v_landlords_active, v_landlords_dormant, now()
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
    landlords_active_90d = EXCLUDED.landlords_active_90d,
    landlords_dormant = EXCLUDED.landlords_dormant,
    updated_at = now();
END;
$function$;

SELECT public.compute_daily_stats();