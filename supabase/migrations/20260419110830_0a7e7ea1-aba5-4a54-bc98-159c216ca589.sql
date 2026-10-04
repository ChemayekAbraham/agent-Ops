-- Boost supporter trust scoring based on portfolio value
-- Progressive tiers starting at UGX 50,000 floor
CREATE OR REPLACE FUNCTION public.get_user_trust_profile(p_ai_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_profile record;
  v_caller uuid := auth.uid();
  v_is_self boolean := false;
  v_is_staff boolean := false;
  v_user_roles text[];
  v_primary_role text;
  v_total_plans int := 0;
  v_total_repaid numeric := 0;
  v_total_owing numeric := 0;
  v_on_time_count int := 0;
  v_late_count int := 0;
  v_on_time_rate numeric := 0;
  v_payment_score numeric := 0;
  v_wallet_balance numeric := 0;
  v_received_180d numeric := 0;
  v_sent_180d numeric := 0;
  v_txn_count int := 0;
  v_wallet_score numeric := 0;
  v_referral_count int := 0;
  v_subagent_count int := 0;
  v_portfolio_value numeric := 0;
  v_role_weight int := 0;
  v_network_score numeric := 0;
  v_portfolio_score int := 0;
  v_verification_items int := 0;
  v_verification_score numeric := 0;
  v_total_score int := 0;
  v_tier text;
  v_data_points int := 0;
  v_borrowing_limit numeric := 0;
BEGIN
  v_user_id := public.resolve_ai_id_to_user(p_ai_id);
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'AI ID not found');
  END IF;

  v_is_self := (v_caller = v_user_id);
  IF v_caller IS NOT NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_caller
        AND role IN ('ceo','cfo','coo','cto','cmo','manager','super_admin','operations','agent')
    ) INTO v_is_staff;
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = v_user_id;

  SELECT array_agg(role::text) INTO v_user_roles
  FROM public.user_roles WHERE user_id = v_user_id;
  v_user_roles := COALESCE(v_user_roles, ARRAY[]::text[]);
  v_primary_role := COALESCE(v_user_roles[1], 'tenant');

  -- ─── PAYMENT HISTORY (35%) ───
  SELECT COUNT(*),
         COALESCE(SUM(CASE WHEN status IN ('completed','repaid') THEN amount ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN status NOT IN ('completed','repaid','cancelled','rejected') THEN amount ELSE 0 END), 0)
  INTO v_total_plans, v_total_repaid, v_total_owing
  FROM public.rent_requests WHERE tenant_id = v_user_id;

  IF v_total_plans > 0 THEN
    SELECT COUNT(*) INTO v_on_time_count
    FROM public.rent_requests
    WHERE tenant_id = v_user_id AND status IN ('completed','repaid');
    v_late_count := GREATEST(0, v_total_plans - v_on_time_count);
    v_on_time_rate := (v_on_time_count::numeric / v_total_plans) * 100;
    v_payment_score := LEAST(100, v_on_time_rate * 0.8 + LEAST(v_total_plans * 2, 20));
    v_data_points := v_data_points + LEAST(v_total_plans, 10);
  END IF;

  -- ─── WALLET ACTIVITY (25%) ───
  BEGIN
    SELECT COALESCE(balance, 0) INTO v_wallet_balance FROM public.wallets WHERE user_id = v_user_id LIMIT 1;
  EXCEPTION WHEN undefined_table THEN v_wallet_balance := 0; END;

  BEGIN
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END), 0),
      COUNT(*)
    INTO v_received_180d, v_sent_180d, v_txn_count
    FROM public.wallet_transactions
    WHERE user_id = v_user_id AND created_at > now() - interval '180 days';
  EXCEPTION WHEN undefined_table THEN v_txn_count := 0; END;

  IF v_txn_count > 0 THEN
    v_wallet_score := LEAST(100,
      LEAST((v_received_180d / 100000)::int, 40) +
      LEAST(v_txn_count * 2, 30) +
      CASE WHEN v_wallet_balance > 0 THEN 30 ELSE 0 END
    );
    v_data_points := v_data_points + LEAST(v_txn_count / 5, 5);
  END IF;

  -- ─── NETWORK & CONTRIBUTION (25%) ───
  SELECT COUNT(*) INTO v_referral_count
  FROM public.profiles WHERE referrer_id = v_user_id;

  SELECT COUNT(*) INTO v_subagent_count
  FROM public.user_roles WHERE role = 'agent'
    AND user_id IN (SELECT id FROM public.profiles WHERE referrer_id = v_user_id);

  -- Portfolio value: try investment_amount first (current schema), fallback to principal_amount
  BEGIN
    SELECT COALESCE(SUM(investment_amount), 0) INTO v_portfolio_value
    FROM public.investor_portfolios
    WHERE (investor_id = v_user_id OR agent_id = v_user_id)
      AND status IN ('active','pending','pending_approval','matured');
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    BEGIN
      SELECT COALESCE(SUM(principal_amount), 0) INTO v_portfolio_value
      FROM public.investor_portfolios WHERE user_id = v_user_id;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      v_portfolio_value := 0;
    END;
  END;

  v_role_weight := CASE
    WHEN 'ceo' = ANY(v_user_roles) OR 'super_admin' = ANY(v_user_roles) THEN 25
    WHEN 'cfo' = ANY(v_user_roles) OR 'coo' = ANY(v_user_roles) OR 'cto' = ANY(v_user_roles) OR 'cmo' = ANY(v_user_roles) THEN 20
    WHEN 'manager' = ANY(v_user_roles) OR 'operations' = ANY(v_user_roles) THEN 15
    WHEN 'agent' = ANY(v_user_roles) THEN 10
    WHEN 'landlord' = ANY(v_user_roles) THEN 8
    WHEN 'supporter' = ANY(v_user_roles) THEN 12
    WHEN 'employee' = ANY(v_user_roles) OR 'hr' = ANY(v_user_roles) OR 'crm' = ANY(v_user_roles) THEN 8
    ELSE 0
  END;

  -- Progressive supporter portfolio scoring (UGX 50k floor → max 50 pts)
  v_portfolio_score := CASE
    WHEN v_portfolio_value >= 100000000 THEN 50  -- 100M+ : Whale
    WHEN v_portfolio_value >= 50000000  THEN 45  -- 50M+  : Major backer
    WHEN v_portfolio_value >= 20000000  THEN 40  -- 20M+  : Strong backer
    WHEN v_portfolio_value >= 10000000  THEN 35  -- 10M+
    WHEN v_portfolio_value >= 5000000   THEN 30  -- 5M+
    WHEN v_portfolio_value >= 2000000   THEN 25  -- 2M+
    WHEN v_portfolio_value >= 1000000   THEN 20  -- 1M+
    WHEN v_portfolio_value >= 500000    THEN 15  -- 500k+
    WHEN v_portfolio_value >= 200000    THEN 12  -- 200k+
    WHEN v_portfolio_value >= 100000    THEN 10  -- 100k+
    WHEN v_portfolio_value >= 50000     THEN 8   -- 50k floor
    ELSE 0
  END;

  v_network_score := LEAST(100,
    (LEAST(v_referral_count, 20) * 3) +
    (LEAST(v_subagent_count, 10) * 4) +
    v_portfolio_score +
    v_role_weight
  );

  IF v_referral_count > 0 OR v_subagent_count > 0 OR v_portfolio_value >= 50000 OR v_role_weight > 0 THEN
    v_data_points := v_data_points + 3;
    -- Bonus data points for substantial portfolios (treated as proven trust signal)
    IF v_portfolio_value >= 1000000 THEN v_data_points := v_data_points + 2; END IF;
    IF v_portfolio_value >= 10000000 THEN v_data_points := v_data_points + 3; END IF;
  END IF;

  -- ─── VERIFICATION STRENGTH (15%) ───
  v_verification_items := 0;
  IF v_profile.full_name IS NOT NULL AND length(v_profile.full_name) > 2 THEN v_verification_items := v_verification_items + 1; END IF;
  IF v_profile.phone IS NOT NULL THEN v_verification_items := v_verification_items + 1; END IF;
  IF v_profile.email IS NOT NULL THEN v_verification_items := v_verification_items + 1; END IF;
  IF v_profile.national_id IS NOT NULL AND length(v_profile.national_id) >= 10 THEN v_verification_items := v_verification_items + 2; END IF;
  IF COALESCE(v_profile.is_verified, false) THEN v_verification_items := v_verification_items + 2; END IF;
  v_verification_score := LEAST(100, v_verification_items * 14);
  v_data_points := v_data_points + v_verification_items;

  -- ─── COMPOSITE SCORE ───
  v_total_score := ROUND(
    (v_payment_score * 0.35) +
    (v_wallet_score * 0.25) +
    (v_network_score * 0.25) +
    (v_verification_score * 0.15)
  );

  -- ─── TIER ───
  IF v_data_points < 5 THEN
    v_tier := 'New';
  ELSIF v_total_score >= 85 THEN v_tier := 'Excellent';
  ELSIF v_total_score >= 70 THEN v_tier := 'Good';
  ELSIF v_total_score >= 55 THEN v_tier := 'Standard';
  ELSIF v_total_score >= 40 THEN v_tier := 'Caution';
  ELSE v_tier := 'High Risk';
  END IF;

  -- ─── BORROWING LIMIT ───
  v_borrowing_limit := CASE v_tier
    WHEN 'Excellent' THEN GREATEST(2000000, v_total_repaid * 0.5)
    WHEN 'Good' THEN GREATEST(1000000, v_total_repaid * 0.3)
    WHEN 'Standard' THEN GREATEST(500000, v_total_repaid * 0.2)
    WHEN 'Caution' THEN 200000
    WHEN 'High Risk' THEN 0
    ELSE 100000
  END;
  -- Supporters with substantial portfolios get elevated limits
  IF v_portfolio_value >= 50000 THEN
    v_borrowing_limit := GREATEST(v_borrowing_limit, v_portfolio_value * 0.5);
  END IF;

  RETURN jsonb_build_object(
    'ai_id', upper(p_ai_id),
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
      'primary_role', v_primary_role
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
      'weights', jsonb_build_object('payment', 35, 'wallet', 25, 'network', 25, 'verification', 15)
    ),
    'payment_history', jsonb_build_object(
      'total_rent_plans', v_total_plans,
      'total_repaid', v_total_repaid,
      'total_owing', v_total_owing,
      'on_time_count', v_on_time_count,
      'late_count', v_late_count,
      'on_time_rate', ROUND(v_on_time_rate, 1)
    ),
    'wallet_activity', jsonb_build_object(
      'balance', CASE WHEN v_is_self OR v_is_staff THEN v_wallet_balance ELSE NULL END,
      'total_received_180d', v_received_180d,
      'total_sent_180d', v_sent_180d,
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
    'generated_at', now()
  );
END;
$$;