CREATE OR REPLACE FUNCTION public.get_user_trust_profile(p_ai_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_caller uuid := auth.uid();
  v_profile record;
  v_roles text[];
  v_primary_role text;
  v_role_weight numeric := 1;
  v_trust_score int := 0;
  v_data_points int := 0;
  v_payment_score int := 0;
  v_wallet_score int := 0;
  v_network_score int := 0;
  v_verification_score int := 0;
  v_portfolio_score int := 0;
  v_portfolio_value numeric := 0;
  v_total_paid numeric := 0;
  v_total_owing numeric := 0;
  v_payments_count int := 0;
  v_on_time_count int := 0;
  v_late_count int := 0;
  v_wallet_inflow numeric := 0;
  v_wallet_outflow numeric := 0;
  v_wallet_txn_count int := 0;
  v_wallet_balance numeric := NULL;
  v_referrals_count int := 0;
  v_sub_agents int := 0;
  v_tier text;
  v_borrowing_limit numeric := 0;
  v_is_self boolean;
  v_is_staff boolean := false;
  v_can_see_pii boolean;
BEGIN
  -- Resolve AI ID to user_id (WEL-XXXXXX -> first 6 chars of UUID)
  SELECT id INTO v_user_id
  FROM profiles
  WHERE 'WEL-' || UPPER(SUBSTRING(REPLACE(id::text,'-',''), 1, 6)) = UPPER(p_ai_id)
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'AI ID not found');
  END IF;

  SELECT id, full_name, phone, email, verified, national_id, created_at, avatar_url
  INTO v_profile
  FROM profiles
  WHERE id = v_user_id;

  -- Roles from user_roles table
  SELECT COALESCE(array_agg(role::text ORDER BY role::text), ARRAY[]::text[])
    INTO v_roles
    FROM user_roles
   WHERE user_id = v_user_id AND COALESCE(enabled, true) = true;

  v_primary_role := COALESCE(v_roles[1], 'tenant');
  v_role_weight := CASE v_primary_role
    WHEN 'supporter' THEN 1.5
    WHEN 'investor' THEN 1.5
    WHEN 'agent' THEN 1.2
    WHEN 'landlord' THEN 1.2
    ELSE 1.0
  END;

  v_is_self := (v_caller IS NOT NULL AND v_caller = v_user_id);
  -- staff check (best-effort, ignore if table missing)
  BEGIN
    SELECT EXISTS(SELECT 1 FROM staff_permissions WHERE user_id = v_caller AND COALESCE(is_active, true)) INTO v_is_staff;
  EXCEPTION WHEN OTHERS THEN v_is_staff := false; END;
  v_can_see_pii := v_is_self OR v_is_staff;

  -- VERIFICATION SCORE (15)
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

  -- PAYMENT HISTORY (35)
  SELECT
    COUNT(*),
    COALESCE(SUM(amount_repaid), 0),
    COALESCE(SUM(GREATEST(rent_amount - COALESCE(amount_repaid,0), 0)), 0),
    COUNT(*) FILTER (WHERE COALESCE(amount_repaid,0) >= rent_amount),
    COUNT(*) FILTER (WHERE COALESCE(amount_repaid,0) < rent_amount)
  INTO v_payments_count, v_total_paid, v_total_owing, v_on_time_count, v_late_count
  FROM rent_requests
  WHERE tenant_id = v_user_id;

  IF v_payments_count > 0 THEN
    v_payment_score := LEAST(35, (v_on_time_count * 35 / GREATEST(v_payments_count, 1)));
    v_data_points := v_data_points + LEAST(v_payments_count, 5);
  END IF;

  -- WALLET ACTIVITY (25)
  SELECT COALESCE(SUM(amount), 0), COUNT(*)
    INTO v_wallet_inflow, v_wallet_txn_count
    FROM wallet_transactions
   WHERE recipient_id = v_user_id
     AND created_at > now() - interval '180 days';

  SELECT COALESCE(SUM(amount), 0)
    INTO v_wallet_outflow
    FROM wallet_transactions
   WHERE sender_id = v_user_id
     AND created_at > now() - interval '180 days';

  IF v_wallet_inflow + v_wallet_outflow > 0 THEN
    v_wallet_score := LEAST(25, (LOG(GREATEST(v_wallet_inflow + v_wallet_outflow, 1))::int * 3));
    v_data_points := v_data_points + 2;
  END IF;

  BEGIN
    SELECT balance INTO v_wallet_balance FROM wallets WHERE user_id = v_user_id LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_wallet_balance := NULL; END;

  -- NETWORK (25)
  SELECT COUNT(*) INTO v_referrals_count FROM profiles WHERE referrer_id = v_user_id;

  BEGIN
    SELECT COUNT(*) INTO v_sub_agents FROM agent_subagents WHERE parent_agent_id = v_user_id AND status = 'verified';
  EXCEPTION WHEN OTHERS THEN v_sub_agents := 0; END;

  v_network_score := LEAST(25, (v_referrals_count * 3) + (v_sub_agents * 2));
  IF v_referrals_count > 0 OR v_sub_agents > 0 THEN
    v_data_points := v_data_points + 1;
  END IF;

  -- PORTFOLIO
  BEGIN
    SELECT COALESCE(SUM(COALESCE(investment_amount, principal_amount, 0)), 0)
      INTO v_portfolio_value
      FROM investor_portfolios
     WHERE (investor_id = v_user_id OR agent_id = v_user_id)
       AND status IN ('active', 'pending', 'pending_approval', 'matured');
  EXCEPTION WHEN OTHERS THEN v_portfolio_value := 0; END;

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

  IF v_portfolio_value >= 1000000 THEN v_data_points := v_data_points + 5;
  ELSIF v_portfolio_value >= 50000 THEN v_data_points := v_data_points + 2;
  END IF;

  -- TOTAL TRUST SCORE (capped 100)
  v_trust_score := LEAST(100, v_verification_score + v_payment_score + v_wallet_score + v_network_score + v_portfolio_score);

  v_tier := CASE
    WHEN v_data_points < 2 THEN 'New'
    WHEN v_trust_score >= 80 THEN 'Excellent'
    WHEN v_trust_score >= 60 THEN 'Good'
    WHEN v_trust_score >= 40 THEN 'Fair'
    ELSE 'Building'
  END;

  v_borrowing_limit := GREATEST(
    CASE WHEN v_payments_count > 0 THEN v_total_paid * 0.5 ELSE 0 END,
    CASE WHEN v_portfolio_value >= 50000 THEN v_portfolio_value * 0.5 ELSE 0 END
  );

  RETURN jsonb_build_object(
    'ai_id', UPPER(p_ai_id),
    'user_id', v_user_id,
    'identity', jsonb_build_object(
      'full_name', v_profile.full_name,
      'phone', CASE WHEN v_can_see_pii THEN v_profile.phone ELSE NULL END,
      'email', CASE WHEN v_can_see_pii THEN v_profile.email ELSE NULL END,
      'national_id', CASE WHEN v_can_see_pii THEN v_profile.national_id ELSE NULL END,
      'national_id_present', v_profile.national_id IS NOT NULL,
      'avatar_url', v_profile.avatar_url,
      'verified', COALESCE(v_profile.verified, false),
      'member_since', v_profile.created_at,
      'roles', to_jsonb(v_roles),
      'primary_role', v_primary_role
    ),
    'trust', jsonb_build_object(
      'score', v_trust_score,
      'tier', v_tier,
      'data_points', v_data_points,
      'borrowing_limit_ugx', v_borrowing_limit,
      'breakdown', jsonb_build_object(
        'payment', v_payment_score,
        'wallet', v_wallet_score,
        'network', v_network_score,
        'verification', v_verification_score
      ),
      'weights', jsonb_build_object(
        'payment', 35,
        'wallet', 25,
        'network', 25,
        'verification', 15
      )
    ),
    'payment_history', jsonb_build_object(
      'total_rent_plans', v_payments_count,
      'total_repaid', v_total_paid,
      'total_owing', v_total_owing,
      'on_time_count', v_on_time_count,
      'late_count', v_late_count,
      'on_time_rate', CASE WHEN v_payments_count > 0 THEN ROUND((v_on_time_count::numeric / v_payments_count) * 100, 1) ELSE 0 END
    ),
    'wallet_activity', jsonb_build_object(
      'balance', v_wallet_balance,
      'total_received_180d', v_wallet_inflow,
      'total_sent_180d', v_wallet_outflow,
      'transaction_count_180d', v_wallet_txn_count
    ),
    'network', jsonb_build_object(
      'referrals', v_referrals_count,
      'sub_agents', v_sub_agents,
      'portfolio_value', v_portfolio_value,
      'role_weight', v_role_weight
    ),
    'permissions', jsonb_build_object(
      'is_self', v_is_self,
      'is_staff_view', v_is_staff,
      'can_see_pii', v_can_see_pii
    ),
    'generated_at', NOW()
  );
END;
$function$;