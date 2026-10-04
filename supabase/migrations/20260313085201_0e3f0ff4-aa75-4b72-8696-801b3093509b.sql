
-- 1. Enable pg_trgm extension for trigram-based phone search
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;

-- 2. GIN trigram index on profiles.phone for fast ILIKE/similarity queries
CREATE INDEX IF NOT EXISTS idx_profiles_phone_trgm ON public.profiles USING gin (phone gin_trgm_ops);

-- 3. Functional index on normalized last-9-digit phone suffix
CREATE INDEX IF NOT EXISTS idx_profiles_phone_last9 ON public.profiles (right(regexp_replace(phone, '\D', '', 'g'), 9));

-- 4. Index on profiles.created_at for pagination
CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON public.profiles (created_at DESC);

-- 5. Daily platform stats table for pre-computed metrics
CREATE TABLE IF NOT EXISTS public.daily_platform_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stat_date date NOT NULL UNIQUE DEFAULT CURRENT_DATE,
  total_users int NOT NULL DEFAULT 0,
  active_users_30d int NOT NULL DEFAULT 0,
  new_users_today int NOT NULL DEFAULT 0,
  retention_pct numeric(5,2) NOT NULL DEFAULT 0,
  referral_pct numeric(5,2) NOT NULL DEFAULT 0,
  daily_transaction_volume numeric NOT NULL DEFAULT 0,
  users_by_role jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: only managers/ceo can read
ALTER TABLE public.daily_platform_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers and executives can read stats"
  ON public.daily_platform_stats FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager') OR 
    public.has_role(auth.uid(), 'ceo') OR 
    public.has_role(auth.uid(), 'coo')
  );

-- 6. Server-side function for paginated user search
CREATE OR REPLACE FUNCTION public.search_users_paginated(
  p_search text DEFAULT '',
  p_role text DEFAULT 'all',
  p_verified text DEFAULT 'all',
  p_sort text DEFAULT 'newest',
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE(
  id uuid,
  full_name text,
  email text,
  phone text,
  avatar_url text,
  rent_discount_active boolean,
  monthly_rent numeric,
  created_at timestamptz,
  country text,
  city text,
  country_code text,
  verified boolean,
  whatsapp_verified boolean,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
BEGIN
  -- Get total count for pagination metadata
  SELECT count(*) INTO v_total
  FROM public.profiles p
  WHERE
    (p_search = '' OR p.full_name ILIKE '%' || p_search || '%' OR p.phone ILIKE '%' || p_search || '%' OR p.email ILIKE '%' || p_search || '%')
    AND (p_role = 'all' OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = p_role::app_role))
    AND (p_verified = 'all' OR (p_verified = 'verified' AND p.verified = true) OR (p_verified = 'pending' AND p.verified = false));

  RETURN QUERY
  SELECT
    p.id, p.full_name, p.email, p.phone, p.avatar_url,
    p.rent_discount_active, p.monthly_rent, p.created_at,
    p.country, p.city, p.country_code, p.verified, p.whatsapp_verified,
    v_total AS total_count
  FROM public.profiles p
  WHERE
    (p_search = '' OR p.full_name ILIKE '%' || p_search || '%' OR p.phone ILIKE '%' || p_search || '%' OR p.email ILIKE '%' || p_search || '%')
    AND (p_role = 'all' OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = p_role::app_role))
    AND (p_verified = 'all' OR (p_verified = 'verified' AND p.verified = true) OR (p_verified = 'pending' AND p.verified = false))
  ORDER BY
    CASE WHEN p_sort = 'newest' THEN p.created_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'oldest' THEN p.created_at END ASC NULLS LAST,
    CASE WHEN p_sort = 'name_asc' THEN p.full_name END ASC NULLS LAST,
    CASE WHEN p_sort = 'name_desc' THEN p.full_name END DESC NULLS LAST
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- 7. Approximate count function (uses pg_class for instant results)
CREATE OR REPLACE FUNCTION public.get_approximate_user_count()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT reltuples::bigint
  FROM pg_class
  WHERE relname = 'profiles';
$$;

-- 8. Function to compute and store daily stats snapshot
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
  SELECT count(*) INTO v_referral_count FROM public.profiles WHERE referred_by IS NOT NULL;
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
