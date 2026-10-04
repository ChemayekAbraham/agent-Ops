
CREATE OR REPLACE FUNCTION public.ops_caller_is_ops()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role IN ('manager','super_admin','cfo','coo','ceo','cto','cmo',
                   'financial_ops','agent_ops','partner_ops',
                   'tenant_ops','landlord_ops','operations','admin')
  );
$$;
REVOKE ALL ON FUNCTION public.ops_caller_is_ops() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_caller_is_ops() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ops_get_profiles_lite(p_ids uuid[])
RETURNS TABLE (id uuid, full_name text, phone text, email text,
               avatar_url text, verified boolean, tenant_status text,
               created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.full_name, p.phone, p.email, p.avatar_url,
         p.verified, p.tenant_status, p.created_at
  FROM public.profiles p
  WHERE p.id = ANY(p_ids) AND public.ops_caller_is_ops();
$$;
REVOKE ALL ON FUNCTION public.ops_get_profiles_lite(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_get_profiles_lite(uuid[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ops_get_wallet_buckets(p_ids uuid[])
RETURNS TABLE (user_id uuid, balance numeric, withdrawable_balance numeric,
               float_balance numeric, advance_balance numeric,
               locked_balance numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.user_id, w.balance, w.withdrawable_balance,
         w.float_balance, w.advance_balance, w.locked_balance
  FROM public.wallets w
  WHERE w.user_id = ANY(p_ids) AND public.ops_caller_is_ops();
$$;
REVOKE ALL ON FUNCTION public.ops_get_wallet_buckets(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_get_wallet_buckets(uuid[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ops_search_landlords(
  p_query text DEFAULT NULL, p_verified_only boolean DEFAULT true,
  p_limit int DEFAULT 50, p_cursor_name text DEFAULT NULL, p_cursor_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, name text, phone text, district text, town_council text,
               house_category text, monthly_rent numeric, verified boolean,
               created_at timestamptz, agent_id uuid, tenant_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q text; v_lim int := LEAST(GREATEST(COALESCE(p_limit,50),1),200);
BEGIN
  IF NOT public.ops_caller_is_ops() THEN RETURN; END IF;
  v_q := NULLIF(TRIM(COALESCE(p_query,'')),'');
  RETURN QUERY
  SELECT l.id, l.name, l.phone, l.district, l.town_council,
         l.house_category, l.monthly_rent, l.verified, l.created_at,
         l.agent_id, l.tenant_id
  FROM public.landlords l
  WHERE (NOT p_verified_only OR l.verified = true)
    AND (v_q IS NULL OR l.name ILIKE '%'||v_q||'%' OR l.phone ILIKE '%'||v_q||'%')
    AND (p_cursor_name IS NULL OR (l.name, l.id) > (p_cursor_name, p_cursor_id))
  ORDER BY l.name ASC, l.id ASC LIMIT v_lim;
END; $$;
REVOKE ALL ON FUNCTION public.ops_search_landlords(text,boolean,int,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_search_landlords(text,boolean,int,text,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ops_search_profiles_enriched(p_query text, p_limit int DEFAULT 20)
RETURNS TABLE (id uuid, full_name text, phone text, email text, avatar_url text,
               verified boolean, tenant_status text, balance numeric,
               withdrawable_balance numeric, float_balance numeric,
               advance_balance numeric, primary_role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q text; v_lim int := LEAST(GREATEST(COALESCE(p_limit,20),1),50);
BEGIN
  IF NOT public.ops_caller_is_ops() THEN RETURN; END IF;
  v_q := NULLIF(TRIM(COALESCE(p_query,'')),'');
  IF v_q IS NULL OR length(v_q) < 2 THEN RETURN; END IF;
  RETURN QUERY
  WITH matches AS (
    SELECT p.id, p.full_name, p.phone, p.email, p.avatar_url, p.verified, p.tenant_status
    FROM public.profiles p
    WHERE p.full_name ILIKE '%'||v_q||'%' OR p.phone ILIKE '%'||v_q||'%' OR p.email ILIKE v_q||'%'
    ORDER BY CASE WHEN p.full_name ILIKE v_q||'%' THEN 0 ELSE 1 END, p.full_name ASC
    LIMIT v_lim)
  SELECT m.id, m.full_name, m.phone, m.email, m.avatar_url, m.verified, m.tenant_status,
         w.balance, w.withdrawable_balance, w.float_balance, w.advance_balance,
         (SELECT ur.role::text FROM public.user_roles ur
          WHERE ur.user_id = m.id AND ur.enabled = true
          ORDER BY ur.created_at ASC LIMIT 1) AS primary_role
  FROM matches m LEFT JOIN public.wallets w ON w.user_id = m.id;
END; $$;
REVOKE ALL ON FUNCTION public.ops_search_profiles_enriched(text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_search_profiles_enriched(text,int) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ops_get_ledger_page(
  p_user_id uuid, p_limit int DEFAULT 50,
  p_cursor_created_at timestamptz DEFAULT NULL, p_cursor_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, amount numeric, direction text, category text,
               description text, created_at timestamptz, wallet_bucket text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lim int := LEAST(GREATEST(COALESCE(p_limit,50),1),200);
BEGIN
  IF auth.uid() <> p_user_id AND NOT public.ops_caller_is_ops() THEN RETURN; END IF;
  RETURN QUERY
  SELECT g.id, g.amount, g.direction, g.category, g.description, g.created_at, g.wallet_bucket
  FROM public.general_ledger g
  WHERE g.user_id = p_user_id AND g.ledger_scope = 'wallet'
    AND g.classification <> 'admin_correction' AND g.category <> 'system_balance_correction'
    AND (p_cursor_created_at IS NULL OR (g.created_at, g.id) < (p_cursor_created_at, p_cursor_id))
  ORDER BY g.created_at DESC, g.id DESC LIMIT v_lim;
END; $$;
REVOKE ALL ON FUNCTION public.ops_get_ledger_page(uuid,int,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_get_ledger_page(uuid,int,timestamptz,uuid) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_house_listings_marketplace_available
  ON public.house_listings (created_at DESC)
  WHERE status = 'approved' AND is_hidden = false AND verified = true AND tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_roles_role_created
  ON public.user_roles (role, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_general_ledger_wallet_userfeed
  ON public.general_ledger (user_id, created_at DESC, id DESC)
  WHERE ledger_scope = 'wallet' AND classification <> 'admin_correction'
    AND category <> 'system_balance_correction';

CREATE INDEX IF NOT EXISTS idx_landlords_verified_name
  ON public.landlords (name ASC, id ASC) WHERE verified = true;

DROP MATERIALIZED VIEW IF EXISTS public.mv_ops_daily_summary CASCADE;
CREATE MATERIALIZED VIEW public.mv_ops_daily_summary AS
SELECT
  now() AS refreshed_at,
  (SELECT count(*) FROM public.withdrawal_requests
     WHERE status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')) AS withdrawals_pending_count,
  (SELECT COALESCE(SUM(amount),0) FROM public.withdrawal_requests
     WHERE status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')) AS withdrawals_pending_ugx,
  (SELECT count(*) FROM public.withdrawal_requests
     WHERE status = 'completed' AND created_at >= date_trunc('day', now())) AS withdrawals_today_count,
  (SELECT COALESCE(SUM(amount),0) FROM public.withdrawal_requests
     WHERE status = 'completed' AND created_at >= date_trunc('day', now())) AS withdrawals_today_ugx,
  (SELECT count(*) FROM public.deposit_requests
     WHERE status = 'verified' AND created_at >= date_trunc('day', now())) AS deposits_today_count,
  (SELECT COALESCE(SUM(amount),0) FROM public.deposit_requests
     WHERE status = 'verified' AND created_at >= date_trunc('day', now())) AS deposits_today_ugx,
  (SELECT count(*) FROM public.profiles) AS total_users,
  (SELECT count(*) FROM public.profiles WHERE created_at >= date_trunc('day', now())) AS users_today,
  (SELECT count(*) FROM public.profiles WHERE last_active_at >= now() - INTERVAL '24 hours') AS active_24h,
  (SELECT count(*) FROM public.landlords WHERE verified = true) AS landlords_verified,
  (SELECT count(*) FROM public.house_listings
     WHERE status = 'approved' AND is_hidden = false AND verified = true AND tenant_id IS NULL) AS listings_available;

CREATE UNIQUE INDEX ON public.mv_ops_daily_summary (refreshed_at);
GRANT SELECT ON public.mv_ops_daily_summary TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_mv_ops_daily_summary()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ops_daily_summary; END; $$;
REVOKE ALL ON FUNCTION public.refresh_mv_ops_daily_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_mv_ops_daily_summary() TO service_role;

CREATE OR REPLACE FUNCTION public.ops_get_daily_summary()
RETURNS SETOF public.mv_ops_daily_summary
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.mv_ops_daily_summary WHERE public.ops_caller_is_ops();
$$;
REVOKE ALL ON FUNCTION public.ops_get_daily_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_get_daily_summary() TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.ops_perf_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screen text NOT NULL, action text NOT NULL,
  duration_ms integer NOT NULL, rows_returned integer, user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now());
GRANT INSERT ON public.ops_perf_metrics TO authenticated;
GRANT ALL ON public.ops_perf_metrics TO service_role;
ALTER TABLE public.ops_perf_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "insert perf metrics" ON public.ops_perf_metrics;
CREATE POLICY "insert perf metrics" ON public.ops_perf_metrics FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "ops view perf metrics" ON public.ops_perf_metrics;
CREATE POLICY "ops view perf metrics" ON public.ops_perf_metrics FOR SELECT TO authenticated USING (public.ops_caller_is_ops());
CREATE INDEX IF NOT EXISTS idx_ops_perf_metrics_screen_created ON public.ops_perf_metrics (screen, created_at DESC);
