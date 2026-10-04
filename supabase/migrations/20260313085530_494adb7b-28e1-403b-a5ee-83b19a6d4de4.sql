
CREATE OR REPLACE FUNCTION public.compute_daily_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total int;
  v_active int;
  v_new_today int;
  v_referral_count int;
  v_daily_txn numeric;
  v_roles jsonb;
  v_today date := CURRENT_DATE;
  v_today_start timestamptz := v_today::timestamptz;
  v_30d_ago timestamptz := v_today_start - interval '30 days';
BEGIN
  SELECT count(*) INTO v_total FROM public.profiles;
  SELECT count(*) INTO v_active FROM public.profiles WHERE updated_at >= v_30d_ago;
  SELECT count(*) INTO v_new_today FROM public.profiles WHERE created_at >= v_today_start;
  SELECT count(*) INTO v_referral_count FROM public.profiles WHERE referrer_id IS NOT NULL;
  SELECT COALESCE(sum(amount), 0) INTO v_daily_txn FROM public.general_ledger WHERE transaction_date >= v_today_start::text;
  
  SELECT jsonb_object_agg(role, cnt) INTO v_roles
  FROM (SELECT role::text, count(*) as cnt FROM public.user_roles WHERE enabled = true GROUP BY role) sub;

  INSERT INTO public.daily_platform_stats (stat_date, total_users, active_users_30d, new_users_today, retention_pct, referral_pct, daily_transaction_volume, users_by_role, updated_at)
  VALUES (
    v_today,
    v_total,
    v_active,
    v_new_today,
    CASE WHEN v_total > 0 THEN round((v_active::numeric / v_total) * 100, 2) ELSE 0 END,
    CASE WHEN v_total > 0 THEN round((v_referral_count::numeric / v_total) * 100, 2) ELSE 0 END,
    v_daily_txn,
    COALESCE(v_roles, '{}'),
    now()
  )
  ON CONFLICT (stat_date) DO UPDATE SET
    total_users = EXCLUDED.total_users,
    active_users_30d = EXCLUDED.active_users_30d,
    new_users_today = EXCLUDED.new_users_today,
    retention_pct = EXCLUDED.retention_pct,
    referral_pct = EXCLUDED.referral_pct,
    daily_transaction_volume = EXCLUDED.daily_transaction_volume,
    users_by_role = EXCLUDED.users_by_role,
    updated_at = now();
END;
$$;
