
-- ============================================================
-- Welile AI ID: Materialized View for Financial Summaries
-- Refreshed periodically (daily via cron), NOT queried live
-- ============================================================

-- 1. SQL function to generate deterministic AI ID from UUID
-- Format: WEL-XXXXXX (6 alphanumeric chars derived from UUID)
CREATE OR REPLACE FUNCTION public.generate_welile_ai_id(user_uuid uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 'WEL-' || upper(substring(replace(user_uuid::text, '-', '') from 1 for 6))
$$;

-- 2. Reverse lookup: find user_id from AI ID
CREATE OR REPLACE FUNCTION public.resolve_welile_ai_id(ai_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT id FROM profiles
  WHERE upper(substring(replace(id::text, '-', '') from 1 for 6)) = upper(replace(ai_id, 'WEL-', ''))
  LIMIT 1
$$;

-- 3. Materialized view: pre-aggregated financial summary per user
CREATE MATERIALIZED VIEW IF NOT EXISTS public.user_financial_summaries AS
SELECT
  p.id AS user_id,
  public.generate_welile_ai_id(p.id) AS ai_id,
  -- Rent summary
  COALESCE(rent.total_rent_facilitated, 0) AS total_rent_facilitated,
  COALESCE(rent.total_rent_requests, 0) AS total_rent_requests,
  COALESCE(rent.funded_requests, 0) AS funded_requests,
  -- Risk tier
  COALESCE(rs.risk_score, 50) AS risk_score,
  COALESCE(rs.risk_level, 'standard') AS risk_level,
  COALESCE(rs.total_on_time_payments, 0) AS total_on_time_payments,
  COALESCE(rs.total_missed_payments, 0) AS total_missed_payments,
  -- Payment consistency
  CASE 
    WHEN COALESCE(rs.total_on_time_payments, 0) + COALESCE(rs.total_missed_payments, 0) = 0 THEN 0
    ELSE round(
      (COALESCE(rs.total_on_time_payments, 0)::numeric / 
       NULLIF(COALESCE(rs.total_on_time_payments, 0) + COALESCE(rs.total_missed_payments, 0), 0)) * 100
    )
  END AS on_time_payment_rate,
  -- Wallet
  COALESCE(w.balance, 0) AS wallet_balance,
  -- Lending capacity estimate (based on risk score + rent history)
  CASE
    WHEN COALESCE(rs.risk_score, 50) >= 80 THEN LEAST(COALESCE(rent.total_rent_facilitated, 0) * 0.5, 5000000)
    WHEN COALESCE(rs.risk_score, 50) >= 60 THEN LEAST(COALESCE(rent.total_rent_facilitated, 0) * 0.3, 2000000)
    WHEN COALESCE(rs.risk_score, 50) >= 40 THEN LEAST(COALESCE(rent.total_rent_facilitated, 0) * 0.15, 500000)
    ELSE 0
  END AS estimated_borrowing_limit,
  -- Referral activity
  COALESCE(ref.referral_count, 0) AS referral_count,
  -- Account age
  p.created_at AS member_since,
  now() AS last_refreshed_at
FROM profiles p
LEFT JOIN (
  SELECT 
    tenant_id,
    SUM(rent_amount) AS total_rent_facilitated,
    COUNT(*) AS total_rent_requests,
    COUNT(*) FILTER (WHERE status IN ('funded', 'disbursed', 'approved')) AS funded_requests
  FROM rent_requests
  GROUP BY tenant_id
) rent ON rent.tenant_id = p.id
LEFT JOIN user_risk_scores rs ON rs.user_id = p.id
LEFT JOIN wallets w ON w.user_id = p.id
LEFT JOIN (
  SELECT referrer_id, COUNT(*) AS referral_count
  FROM referrals
  GROUP BY referrer_id
) ref ON ref.referrer_id = p.id;

-- 4. Unique index on ai_id for fast lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_ufs_user_id ON public.user_financial_summaries (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ufs_ai_id ON public.user_financial_summaries (ai_id);

-- 5. Function to refresh the materialized view (called by cron)
CREATE OR REPLACE FUNCTION public.refresh_financial_summaries()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.user_financial_summaries;
END;
$$;

-- 6. RLS on materialized views isn't supported, so we create a wrapper function
-- that enforces access control for AI ID lookups
CREATE OR REPLACE FUNCTION public.lookup_ai_id(p_ai_id text)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  result json;
BEGIN
  -- Anyone authenticated can look up an AI ID (non-identifying data only)
  IF auth.uid() IS NULL THEN
    RETURN json_build_object('error', 'Authentication required');
  END IF;

  SELECT json_build_object(
    'ai_id', ufs.ai_id,
    'total_rent_facilitated', ufs.total_rent_facilitated,
    'total_rent_requests', ufs.total_rent_requests,
    'funded_requests', ufs.funded_requests,
    'risk_level', ufs.risk_level,
    'risk_score', ufs.risk_score,
    'on_time_payment_rate', ufs.on_time_payment_rate,
    'estimated_borrowing_limit', ufs.estimated_borrowing_limit,
    'referral_count', ufs.referral_count,
    'member_since', ufs.member_since,
    'last_refreshed_at', ufs.last_refreshed_at
  ) INTO result
  FROM user_financial_summaries ufs
  WHERE ufs.ai_id = upper(p_ai_id);

  IF result IS NULL THEN
    RETURN json_build_object('error', 'AI ID not found');
  END IF;

  RETURN result;
END;
$$;

-- 7. Function for self-lookup (returns own data including lending eligibility)
CREATE OR REPLACE FUNCTION public.get_my_ai_id_summary()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  result json;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN json_build_object('error', 'Authentication required');
  END IF;

  SELECT json_build_object(
    'ai_id', ufs.ai_id,
    'total_rent_facilitated', ufs.total_rent_facilitated,
    'total_rent_requests', ufs.total_rent_requests,
    'funded_requests', ufs.funded_requests,
    'risk_level', ufs.risk_level,
    'risk_score', ufs.risk_score,
    'on_time_payment_rate', ufs.on_time_payment_rate,
    'estimated_borrowing_limit', ufs.estimated_borrowing_limit,
    'wallet_balance', ufs.wallet_balance,
    'referral_count', ufs.referral_count,
    'member_since', ufs.member_since,
    'last_refreshed_at', ufs.last_refreshed_at,
    'can_lend', (
      SELECT EXISTS (
        SELECT 1 FROM user_roles 
        WHERE user_id = auth.uid() 
        AND role IN ('supporter', 'manager')
      )
    )
  ) INTO result
  FROM user_financial_summaries ufs
  WHERE ufs.user_id = auth.uid();

  IF result IS NULL THEN
    RETURN json_build_object(
      'ai_id', public.generate_welile_ai_id(auth.uid()),
      'total_rent_facilitated', 0,
      'total_rent_requests', 0,
      'funded_requests', 0,
      'risk_level', 'new',
      'risk_score', 50,
      'on_time_payment_rate', 0,
      'estimated_borrowing_limit', 0,
      'wallet_balance', 0,
      'referral_count', 0,
      'member_since', now(),
      'last_refreshed_at', now(),
      'can_lend', false
    );
  END IF;

  RETURN result;
END;
$$;
