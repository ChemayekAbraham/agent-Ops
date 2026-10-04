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
  v_trust_score int := 0;
  v_data_points int := 0;
  v_payment_score int := 0;
  v_wallet_score int := 0;
  v_network_score int := 0;
  v_verification_score int := 0;
  v_portfolio_score int := 0;
  v_portfolio_value numeric := 0;
  v_total_paid numeric := 0;
  v_payments_count int := 0;
  v_on_time_count int := 0;
  v_wallet_inflow numeric := 0;
  v_wallet_outflow numeric := 0;
  v_referrals_count int := 0;
  v_role text;
  v_tier text;
  v_borrowing_limit numeric := 0;
BEGIN
  -- Resolve AI ID to user_id (WEL-XXXXXX -> first 6 chars of UUID)
  SELECT id INTO v_user_id
  FROM profiles
  WHERE 'WEL-' || UPPER(SUBSTRING(id::text, 1, 6)) = UPPER(p_ai_id)
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'profile_not_found');
  END IF;

  SELECT id, full_name, phone, email, role, verified, national_id, created_at, avatar_url
  INTO v_profile
  FROM profiles
  WHERE id = v_user_id;

  v_role := COALESCE(v_profile.role, 'tenant');

  -- VERIFICATION SCORE (15%)
  IF v_profile.verified THEN
    v_verification_score := v_verification_score + 8;
    v_data_points := v_data_points + 1;
  END IF;
  IF v_profile.national_id IS NOT NULL AND length(v_profile.national_id) >= 10 THEN
    v_verification_score := v_verification_score + 5;
    v_data_points := v_data_points + 1;
  END IF;
  IF v_profile.phone IS NOT NULL THEN
    v_verification_score := v_verification_score + 2;
  END IF;

  -- PAYMENT HISTORY (35%) - rent_requests as tenant
  SELECT 
    COUNT(*),
    COALESCE(SUM(amount_repaid), 0),
    COUNT(*) FILTER (WHERE amount_repaid >= rent_amount)
  INTO v_payments_count, v_total_paid, v_on_time_count
  FROM rent_requests
  WHERE tenant_id = v_user_id;

  IF v_payments_count > 0 THEN
    v_payment_score := LEAST(35, (v_on_time_count * 35 / GREATEST(v_payments_count, 1)));
    v_data_points := v_data_points + LEAST(v_payments_count, 5);
  END IF;

  -- WALLET ACTIVITY (25%)
  SELECT COALESCE(SUM(amount), 0) INTO v_wallet_inflow
  FROM wallet_transactions
  WHERE recipient_id = v_user_id;
  
  SELECT COALESCE(SUM(amount), 0) INTO v_wallet_outflow
  FROM wallet_transactions
  WHERE sender_id = v_user_id;

  IF v_wallet_inflow + v_wallet_outflow > 0 THEN
    v_wallet_score := LEAST(25, (LOG(GREATEST(v_wallet_inflow + v_wallet_outflow, 1))::int * 3));
    v_data_points := v_data_points + 2;
  END IF;

  -- NETWORK (25%) - referrals
  SELECT COUNT(*) INTO v_referrals_count
  FROM profiles WHERE referrer_id = v_user_id;

  v_network_score := LEAST(25, v_referrals_count * 3);
  IF v_referrals_count > 0 THEN
    v_data_points := v_data_points + 1;
  END IF;

  -- PORTFOLIO (Supporter bonus)
  SELECT COALESCE(SUM(COALESCE(investment_amount, 0)), 0) INTO v_portfolio_value
  FROM investor_portfolios
  WHERE (investor_id = v_user_id OR agent_id = v_user_id)
    AND status IN ('active', 'pending', 'pending_approval', 'matured');

  v_portfolio_score := CASE
    WHEN v_portfolio_value >= 100000000 THEN 50
    WHEN v_portfolio_value >= 50000000 THEN 45
    WHEN v_portfolio_value >= 10000000 THEN 38
    WHEN v_portfolio_value >= 5000000 THEN 30
    WHEN v_portfolio_value >= 1000000 THEN 22
    WHEN v_portfolio_value >= 500000 THEN 16
    WHEN v_portfolio_value >= 100000 THEN 12
    WHEN v_portfolio_value >= 50000 THEN 8
    ELSE 0
  END;

  IF v_portfolio_value >= 1000000 THEN
    v_data_points := v_data_points + 5;
  ELSIF v_portfolio_value >= 50000 THEN
    v_data_points := v_data_points + 2;
  END IF;

  -- TOTAL TRUST SCORE (capped 100)
  v_trust_score := LEAST(100, v_verification_score + v_payment_score + v_wallet_score + v_network_score + v_portfolio_score);

  -- TIER
  v_tier := CASE
    WHEN v_data_points < 2 THEN 'New'
    WHEN v_trust_score >= 80 THEN 'Excellent'
    WHEN v_trust_score >= 60 THEN 'Good'
    WHEN v_trust_score >= 40 THEN 'Fair'
    ELSE 'Building'
  END;

  -- BORROWING LIMIT
  v_borrowing_limit := GREATEST(
    CASE WHEN v_payments_count > 0 THEN v_total_paid * 0.5 ELSE 0 END,
    CASE WHEN v_portfolio_value >= 50000 THEN v_portfolio_value * 0.5 ELSE 0 END
  );

  RETURN jsonb_build_object(
    'ai_id', p_ai_id,
    'user_id', v_user_id,
    'full_name', v_profile.full_name,
    'role', v_role,
    'avatar_url', v_profile.avatar_url,
    'verified', COALESCE(v_profile.verified, false),
    'has_national_id', v_profile.national_id IS NOT NULL,
    'member_since', v_profile.created_at,
    'trust_score', v_trust_score,
    'tier', v_tier,
    'data_points', v_data_points,
    'breakdown', jsonb_build_object(
      'payment', v_payment_score,
      'wallet', v_wallet_score,
      'network', v_network_score,
      'verification', v_verification_score,
      'portfolio', v_portfolio_score
    ),
    'stats', jsonb_build_object(
      'total_paid', v_total_paid,
      'payments_count', v_payments_count,
      'on_time_count', v_on_time_count,
      'wallet_volume', v_wallet_inflow + v_wallet_outflow,
      'referrals_count', v_referrals_count,
      'portfolio_value', v_portfolio_value
    ),
    'borrowing_limit', v_borrowing_limit
  );
END;
$$;