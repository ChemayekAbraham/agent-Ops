-- ─────────────────────────────────────────────────────────────────────────────
-- WELILE AI TRUST PROFILE — Universal trust passport for every Welile user
-- Formula: Payment 35% + Wallet 25% + Network 25% + Verification 15%
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper: resolve user_id from WEL-XXXXXX AI ID
CREATE OR REPLACE FUNCTION public.resolve_ai_id_to_user(p_ai_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.profiles
  WHERE UPPER(REPLACE(SUBSTRING(id::text, 1, 8), '-', '')) = UPPER(REPLACE(p_ai_id, 'WEL-', ''))
     OR UPPER(SUBSTRING(REPLACE(id::text, '-', ''), 1, 6)) = UPPER(REPLACE(p_ai_id, 'WEL-', ''))
  LIMIT 1;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- AUTHENTICATED: Full holistic trust profile
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_user_trust_profile(p_ai_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_profile record;
  v_caller uuid := auth.uid();
  v_is_self boolean;
  v_is_staff boolean;

  -- Payment metrics
  v_total_requests int := 0;
  v_total_repaid numeric := 0;
  v_total_owed numeric := 0;
  v_on_time_count int := 0;
  v_late_count int := 0;
  v_payment_score numeric := 0;

  -- Wallet metrics
  v_wallet_balance numeric := 0;
  v_total_deposits numeric := 0;
  v_total_withdrawals numeric := 0;
  v_txn_count int := 0;
  v_wallet_score numeric := 0;

  -- Network metrics
  v_referral_count int := 0;
  v_subagent_count int := 0;
  v_portfolio_value numeric := 0;
  v_role_weight numeric := 0;
  v_network_score numeric := 0;

  -- Verification metrics
  v_verification_score numeric := 0;
  v_verification_items int := 0;

  -- Final
  v_total_score numeric := 0;
  v_data_points int := 0;
  v_tier text;
  v_borrowing_limit numeric := 0;
  v_user_roles text[];
BEGIN
  -- Resolve AI ID to user
  v_user_id := resolve_ai_id_to_user(p_ai_id);
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'AI ID not found');
  END IF;

  -- Permission flags
  v_is_self := (v_caller = v_user_id);
  v_is_staff := EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_caller
      AND role IN ('manager', 'agent', 'landlord_ops', 'tenant_ops', 'agent_ops', 'cfo', 'coo', 'ceo', 'super_admin')
  );

  -- Load profile
  SELECT * INTO v_profile FROM public.profiles WHERE id = v_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Profile not found');
  END IF;

  -- Load roles
  SELECT array_agg(role::text) INTO v_user_roles
  FROM public.user_roles WHERE user_id = v_user_id;
  v_user_roles := COALESCE(v_user_roles, ARRAY['tenant']);

  -- ─── PAYMENT BEHAVIOR (35%) ───
  SELECT
    COUNT(*),
    COALESCE(SUM(amount_repaid), 0),
    COALESCE(SUM(GREATEST(total_repayment - amount_repaid, 0)), 0),
    COUNT(*) FILTER (WHERE status = 'completed' AND amount_repaid >= total_repayment),
    COUNT(*) FILTER (WHERE status IN ('overdue', 'defaulted'))
  INTO v_total_requests, v_total_repaid, v_total_owed, v_on_time_count, v_late_count
  FROM public.rent_requests
  WHERE tenant_id = v_user_id;

  IF v_total_requests > 0 THEN
    v_payment_score := LEAST(100, (v_on_time_count::numeric * 100.0 / v_total_requests) - (v_late_count * 10));
    v_payment_score := GREATEST(0, v_payment_score);
    v_data_points := v_data_points + LEAST(v_total_requests, 10);
  END IF;

  -- ─── WALLET ACTIVITY (25%) ───
  SELECT COALESCE(balance, 0) INTO v_wallet_balance
  FROM public.wallets WHERE user_id = v_user_id LIMIT 1;

  SELECT
    COUNT(*),
    COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' OR type = 'credit'), 0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'withdrawal' OR type = 'debit'), 0)
  INTO v_txn_count, v_total_deposits, v_total_withdrawals
  FROM public.wallet_transactions
  WHERE user_id = v_user_id
    AND created_at >= NOW() - INTERVAL '180 days';

  IF v_txn_count > 0 THEN
    -- Reward consistent activity, balance health, deposit/withdrawal ratio
    v_wallet_score := LEAST(100,
      (LEAST(v_txn_count, 50) * 1.5) +              -- up to 75 from activity
      (CASE WHEN v_wallet_balance > 100000 THEN 15 WHEN v_wallet_balance > 10000 THEN 8 ELSE 0 END) +
      (CASE WHEN v_total_deposits > v_total_withdrawals THEN 10 ELSE 0 END)
    );
    v_data_points := v_data_points + LEAST(v_txn_count / 5, 5);
  END IF;

  -- ─── NETWORK & CONTRIBUTION (25%) ───
  SELECT COUNT(*) INTO v_referral_count
  FROM public.profiles WHERE referrer_id = v_user_id;

  SELECT COUNT(*) INTO v_subagent_count
  FROM public.user_roles WHERE role = 'agent'
    AND user_id IN (SELECT id FROM public.profiles WHERE referrer_id = v_user_id);

  -- Portfolio value (for supporters)
  BEGIN
    SELECT COALESCE(SUM(principal_amount), 0) INTO v_portfolio_value
    FROM public.investor_portfolios WHERE user_id = v_user_id;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_portfolio_value := 0;
  END;

  -- Role-based weight boost
  v_role_weight := CASE
    WHEN 'ceo' = ANY(v_user_roles) OR 'super_admin' = ANY(v_user_roles) THEN 25
    WHEN 'cfo' = ANY(v_user_roles) OR 'coo' = ANY(v_user_roles) THEN 20
    WHEN 'manager' = ANY(v_user_roles) THEN 15
    WHEN 'agent' = ANY(v_user_roles) THEN 10
    WHEN 'landlord' = ANY(v_user_roles) THEN 8
    WHEN 'supporter' = ANY(v_user_roles) THEN 12
    ELSE 0
  END;

  v_network_score := LEAST(100,
    (LEAST(v_referral_count, 20) * 3) +              -- up to 60 from referrals
    (LEAST(v_subagent_count, 10) * 4) +              -- up to 40 from subagents
    (CASE WHEN v_portfolio_value > 1000000 THEN 20 WHEN v_portfolio_value > 100000 THEN 10 ELSE 0 END) +
    v_role_weight
  );

  IF v_referral_count > 0 OR v_subagent_count > 0 OR v_portfolio_value > 0 OR v_role_weight > 0 THEN
    v_data_points := v_data_points + 3;
  END IF;

  -- ─── VERIFICATION STRENGTH (15%) ───
  v_verification_items := 0;
  IF v_profile.full_name IS NOT NULL AND length(v_profile.full_name) > 2 THEN v_verification_items := v_verification_items + 1; END IF;
  IF v_profile.phone IS NOT NULL THEN v_verification_items := v_verification_items + 1; END IF;
  IF v_profile.email IS NOT NULL THEN v_verification_items := v_verification_items + 1; END IF;
  IF v_profile.national_id IS NOT NULL AND length(v_profile.national_id) >= 10 THEN v_verification_items := v_verification_items + 2; END IF;
  IF v_profile.avatar_url IS NOT NULL THEN v_verification_items := v_verification_items + 1; END IF;
  IF COALESCE(v_profile.is_verified, false) THEN v_verification_items := v_verification_items + 2; END IF;

  v_verification_score := LEAST(100, v_verification_items * 100.0 / 8);
  v_data_points := v_data_points + LEAST(v_verification_items, 4);

  -- ─── COMPOSITE SCORE ───
  v_total_score := ROUND(
    (v_payment_score * 0.35) +
    (v_wallet_score * 0.25) +
    (v_network_score * 0.25) +
    (v_verification_score * 0.15)
  );

  -- Tier assignment
  v_tier := CASE
    WHEN v_data_points < 5 THEN 'new'
    WHEN v_total_score >= 80 THEN 'excellent'
    WHEN v_total_score >= 65 THEN 'good'
    WHEN v_total_score >= 50 THEN 'standard'
    WHEN v_total_score >= 35 THEN 'caution'
    ELSE 'high_risk'
  END;

  -- Borrowing limit recommendation (UGX)
  v_borrowing_limit := CASE v_tier
    WHEN 'excellent' THEN GREATEST(2000000, v_total_repaid * 1.5)
    WHEN 'good' THEN GREATEST(1000000, v_total_repaid * 1.2)
    WHEN 'standard' THEN GREATEST(500000, v_total_repaid * 0.8)
    WHEN 'caution' THEN GREATEST(200000, v_total_repaid * 0.4)
    WHEN 'high_risk' THEN 0
    ELSE 100000  -- new
  END;

  -- ─── RETURN ───
  RETURN jsonb_build_object(
    'ai_id', 'WEL-' || UPPER(SUBSTRING(REPLACE(v_user_id::text, '-', ''), 1, 6)),
    'user_id', CASE WHEN v_is_self OR v_is_staff THEN v_user_id ELSE NULL END,
    'identity', jsonb_build_object(
      'full_name', COALESCE(v_profile.full_name, 'Welile Member'),
      'phone', CASE WHEN v_is_self OR v_is_staff THEN v_profile.phone ELSE NULL END,
      'email', CASE WHEN v_is_self OR v_is_staff THEN v_profile.email ELSE NULL END,
      'national_id', CASE WHEN v_is_self OR v_is_staff THEN v_profile.national_id ELSE NULL END,
      'national_id_present', v_profile.national_id IS NOT NULL,
      'avatar_url', v_profile.avatar_url,
      'verified', COALESCE(v_profile.is_verified, false),
      'member_since', v_profile.created_at,
      'roles', v_user_roles,
      'primary_role', COALESCE(v_user_roles[1], 'tenant')
    ),
    'trust', jsonb_build_object(
      'score', v_total_score,
      'tier', v_tier,
      'data_points', v_data_points,
      'borrowing_limit_ugx', v_borrowing_limit,
      'breakdown', jsonb_build_object(
        'payment', ROUND(v_payment_score),
        'wallet', ROUND(v_wallet_score),
        'network', ROUND(v_network_score),
        'verification', ROUND(v_verification_score)
      ),
      'weights', jsonb_build_object(
        'payment', 35, 'wallet', 25, 'network', 25, 'verification', 15
      )
    ),
    'payment_history', jsonb_build_object(
      'total_rent_plans', v_total_requests,
      'total_repaid', v_total_repaid,
      'total_owing', v_total_owed,
      'on_time_count', v_on_time_count,
      'late_count', v_late_count,
      'on_time_rate', CASE WHEN v_total_requests > 0 THEN ROUND(v_on_time_count::numeric * 100.0 / v_total_requests) ELSE 0 END
    ),
    'wallet_activity', jsonb_build_object(
      'balance', CASE WHEN v_is_self OR v_is_staff THEN v_wallet_balance ELSE NULL END,
      'total_deposits_180d', v_total_deposits,
      'total_withdrawals_180d', v_total_withdrawals,
      'transaction_count_180d', v_txn_count
    ),
    'network', jsonb_build_object(
      'referrals', v_referral_count,
      'sub_agents', v_subagent_count,
      'portfolio_value', CASE WHEN v_is_self OR v_is_staff THEN v_portfolio_value ELSE NULL END,
      'role_weight', v_role_weight
    ),
    'permissions', jsonb_build_object(
      'is_self', v_is_self,
      'is_staff_view', v_is_staff,
      'can_see_pii', v_is_self OR v_is_staff
    ),
    'generated_at', NOW()
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PUBLIC: Privacy-safe version for shareable lender links (anon access)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_public_trust_profile(p_ai_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full jsonb;
BEGIN
  v_full := get_user_trust_profile(p_ai_id);
  IF v_full ? 'error' THEN RETURN v_full; END IF;

  -- Strip all PII for public view
  RETURN jsonb_build_object(
    'ai_id', v_full->'ai_id',
    'identity', jsonb_build_object(
      'full_name', v_full->'identity'->'full_name',
      'avatar_url', v_full->'identity'->'avatar_url',
      'verified', v_full->'identity'->'verified',
      'member_since', v_full->'identity'->'member_since',
      'primary_role', v_full->'identity'->'primary_role',
      'national_id_present', v_full->'identity'->'national_id_present'
    ),
    'trust', v_full->'trust',
    'payment_history', jsonb_build_object(
      'total_rent_plans', v_full->'payment_history'->'total_rent_plans',
      'on_time_rate', v_full->'payment_history'->'on_time_rate'
    ),
    'network', jsonb_build_object(
      'referrals', v_full->'network'->'referrals',
      'sub_agents', v_full->'network'->'sub_agents'
    ),
    'welile_vouches', true,
    'generated_at', NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_trust_profile(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_trust_profile(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.resolve_ai_id_to_user(text) TO authenticated, anon;