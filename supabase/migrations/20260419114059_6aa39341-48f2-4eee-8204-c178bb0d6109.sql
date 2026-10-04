
-- 1) venue_visits table
CREATE TABLE IF NOT EXISTS public.venue_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('worship','mall','restaurant','hotel','shop','market','school','workplace','other')),
  venue_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_minutes INT,
  paid_with_wallet BOOLEAN DEFAULT false,
  wallet_amount NUMERIC,
  source TEXT DEFAULT 'auto_classified',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venue_visits_user ON public.venue_visits(user_id);
CREATE INDEX IF NOT EXISTS idx_venue_visits_category ON public.venue_visits(category);
CREATE INDEX IF NOT EXISTS idx_venue_visits_visited_at ON public.venue_visits(visited_at DESC);

ALTER TABLE public.venue_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users insert own venue visits" ON public.venue_visits;
CREATE POLICY "Users insert own venue visits"
  ON public.venue_visits FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users view own venue visits" ON public.venue_visits;
CREATE POLICY "Users view own venue visits"
  ON public.venue_visits FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'manager'::app_role));

DROP POLICY IF EXISTS "Managers manage venue visits" ON public.venue_visits;
CREATE POLICY "Managers manage venue visits"
  ON public.venue_visits FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'::app_role));

-- 2) Profile flags for continuous GPS sharing
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS always_share_location BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_continuous_location_at TIMESTAMPTZ;

-- 3) Replace trust profile RPC with behavior-heavy scoring
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
  v_trust_score numeric := 0;
  v_data_points int := 0;

  v_payment_score numeric := 0;        -- /25
  v_wallet_score numeric := 0;         -- /20
  v_network_score numeric := 0;        -- /15
  v_verification_score numeric := 0;   -- /15 (verification + GPS)
  v_behavior_score numeric := 0;       -- /20
  v_landlord_score numeric := 0;       -- /5

  v_total_paid numeric := 0;
  v_total_owing numeric := 0;
  v_payments_count int := 0;
  v_on_time_count int := 0;
  v_late_count int := 0;

  v_wallet_inflow numeric := 0;
  v_wallet_outflow numeric := 0;
  v_wallet_txn_count int := 0;
  v_wallet_balance numeric := NULL;
  v_wallet_inflow_30d numeric := 0;
  v_wallet_outflow_30d numeric := 0;
  v_wallet_inflow_90d numeric := 0;
  v_wallet_outflow_90d numeric := 0;
  v_total_flow_90d numeric := 0;

  v_referrals_count int := 0;
  v_sub_agents int := 0;
  v_tenants_onboarded int := 0;

  v_portfolio_value numeric := 0;

  v_landlord_listings int := 0;
  v_verified_listings int := 0;

  v_visits_total int := 0;
  v_visits_worship int := 0;
  v_visits_mall int := 0;
  v_visits_restaurant int := 0;
  v_visits_hotel int := 0;
  v_visits_shop int := 0;
  v_wallet_shop_count int := 0;

  v_location_count_30d int := 0;
  v_always_gps boolean := false;

  v_tier text;
  v_borrowing_limit numeric := 0;
  v_is_self boolean;
  v_is_staff boolean := false;
  v_can_see_pii boolean;
BEGIN
  -- Resolve AI ID -> user_id
  SELECT id INTO v_user_id
  FROM profiles
  WHERE 'WEL-' || UPPER(SUBSTRING(REPLACE(id::text,'-',''), 1, 6)) = UPPER(p_ai_id)
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'AI ID not found');
  END IF;

  SELECT id, full_name, phone, email, verified, national_id, created_at, avatar_url,
         COALESCE(always_share_location, false) AS always_share_location,
         last_continuous_location_at
  INTO v_profile
  FROM profiles WHERE id = v_user_id;

  v_always_gps := v_profile.always_share_location;

  SELECT COALESCE(array_agg(role::text ORDER BY role::text), ARRAY[]::text[])
    INTO v_roles
    FROM user_roles WHERE user_id = v_user_id AND COALESCE(enabled, true) = true;

  v_primary_role := COALESCE(v_roles[1], 'tenant');

  v_is_self := (v_caller IS NOT NULL AND v_caller = v_user_id);
  BEGIN
    SELECT EXISTS(SELECT 1 FROM staff_permissions WHERE user_id = v_caller AND COALESCE(is_active, true)) INTO v_is_staff;
  EXCEPTION WHEN OTHERS THEN v_is_staff := false; END;
  v_can_see_pii := v_is_self OR v_is_staff;

  -- ============ PAYMENT (25) ============
  SELECT
    COUNT(*),
    COALESCE(SUM(amount_repaid), 0),
    COALESCE(SUM(GREATEST(rent_amount - COALESCE(amount_repaid,0), 0)), 0),
    COUNT(*) FILTER (WHERE COALESCE(amount_repaid,0) >= rent_amount),
    COUNT(*) FILTER (WHERE COALESCE(amount_repaid,0) < rent_amount)
  INTO v_payments_count, v_total_paid, v_total_owing, v_on_time_count, v_late_count
  FROM rent_requests WHERE tenant_id = v_user_id;

  IF v_payments_count > 0 THEN
    v_payment_score := LEAST(25, (v_on_time_count::numeric * 25 / GREATEST(v_payments_count, 1)));
    v_data_points := v_data_points + LEAST(v_payments_count, 5);
  END IF;

  -- ============ WALLET (20) — cash flow ============
  SELECT COALESCE(SUM(amount), 0), COUNT(*)
    INTO v_wallet_inflow, v_wallet_txn_count
    FROM wallet_transactions
   WHERE recipient_id = v_user_id AND created_at > now() - interval '180 days';

  SELECT COALESCE(SUM(amount), 0)
    INTO v_wallet_outflow
    FROM wallet_transactions
   WHERE sender_id = v_user_id AND created_at > now() - interval '180 days';

  -- 30d
  SELECT COALESCE(SUM(amount), 0) INTO v_wallet_inflow_30d
    FROM wallet_transactions WHERE recipient_id = v_user_id AND created_at > now() - interval '30 days';
  SELECT COALESCE(SUM(amount), 0) INTO v_wallet_outflow_30d
    FROM wallet_transactions WHERE sender_id = v_user_id AND created_at > now() - interval '30 days';
  -- 90d
  SELECT COALESCE(SUM(amount), 0) INTO v_wallet_inflow_90d
    FROM wallet_transactions WHERE recipient_id = v_user_id AND created_at > now() - interval '90 days';
  SELECT COALESCE(SUM(amount), 0) INTO v_wallet_outflow_90d
    FROM wallet_transactions WHERE sender_id = v_user_id AND created_at > now() - interval '90 days';

  v_total_flow_90d := v_wallet_inflow_90d + v_wallet_outflow_90d;

  IF v_total_flow_90d > 0 THEN
    -- log scale: ~1M -> 12pts, ~10M -> 18pts, capped 20
    v_wallet_score := LEAST(20, (LOG(GREATEST(v_total_flow_90d, 10))::numeric * 2.2));
    v_data_points := v_data_points + 2;
  END IF;

  BEGIN
    SELECT balance INTO v_wallet_balance FROM wallets WHERE user_id = v_user_id LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_wallet_balance := NULL; END;

  -- ============ NETWORK (15) — onboarding strength ============
  SELECT COUNT(*) INTO v_referrals_count FROM profiles WHERE referrer_id = v_user_id;

  BEGIN
    SELECT COUNT(*) INTO v_sub_agents FROM agent_subagents
      WHERE parent_agent_id = v_user_id AND status = 'verified';
  EXCEPTION WHEN OTHERS THEN v_sub_agents := 0; END;

  BEGIN
    SELECT COUNT(DISTINCT tenant_id) INTO v_tenants_onboarded
      FROM rent_requests WHERE agent_id = v_user_id AND tenant_id IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN v_tenants_onboarded := 0; END;

  v_network_score := LEAST(15,
      (v_referrals_count * 1.5)
    + (v_sub_agents * 1.0)
    + (v_tenants_onboarded * 0.8)
  );
  IF v_referrals_count + v_sub_agents + v_tenants_onboarded > 0 THEN
    v_data_points := v_data_points + 1;
  END IF;

  -- ============ VERIFICATION + GPS (15) ============
  IF v_profile.verified THEN
    v_verification_score := v_verification_score + 4;
    v_data_points := v_data_points + 1;
  END IF;
  IF v_profile.national_id IS NOT NULL AND length(v_profile.national_id) >= 10 THEN
    v_verification_score := v_verification_score + 3;
    v_data_points := v_data_points + 1;
  END IF;
  IF v_profile.phone IS NOT NULL THEN
    v_verification_score := v_verification_score + 1;
  END IF;

  -- GPS reliability: count distinct location captures in 30d
  SELECT COUNT(*) INTO v_location_count_30d
    FROM user_locations WHERE user_id = v_user_id AND captured_at > now() - interval '30 days';

  IF v_always_gps THEN
    v_verification_score := v_verification_score + 4;
    v_data_points := v_data_points + 1;
  END IF;
  IF v_location_count_30d >= 30 THEN
    v_verification_score := v_verification_score + 3;
  ELSIF v_location_count_30d >= 10 THEN
    v_verification_score := v_verification_score + 2;
  ELSIF v_location_count_30d >= 3 THEN
    v_verification_score := v_verification_score + 1;
  END IF;

  v_verification_score := LEAST(15, v_verification_score);

  -- ============ BEHAVIOR (20) — physical movement ============
  -- Last 60 days of categorized visits
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE category = 'worship'),
    COUNT(*) FILTER (WHERE category = 'mall'),
    COUNT(*) FILTER (WHERE category = 'restaurant'),
    COUNT(*) FILTER (WHERE category = 'hotel'),
    COUNT(*) FILTER (WHERE category IN ('shop','market')),
    COUNT(*) FILTER (WHERE paid_with_wallet = true)
  INTO v_visits_total, v_visits_worship, v_visits_mall, v_visits_restaurant, v_visits_hotel, v_visits_shop, v_wallet_shop_count
  FROM venue_visits
  WHERE user_id = v_user_id AND visited_at > now() - interval '60 days';

  -- Worship is weighted highest (regular routine), then malls/restaurants/hotels (findability)
  v_behavior_score :=
      LEAST(8, v_visits_worship * 1.0)
    + LEAST(5, v_visits_mall * 0.5)
    + LEAST(4, v_visits_restaurant * 0.4)
    + LEAST(3, v_visits_hotel * 0.5)
    + LEAST(5, v_wallet_shop_count * 0.6);

  v_behavior_score := LEAST(20, v_behavior_score);
  IF v_visits_total > 0 THEN
    v_data_points := v_data_points + LEAST(3, v_visits_total / 5);
  END IF;

  -- ============ LANDLORD LISTINGS (5) ============
  BEGIN
    SELECT COUNT(*), COUNT(*) FILTER (WHERE COALESCE(verified,false))
      INTO v_landlord_listings, v_verified_listings
      FROM landlords WHERE registered_by = v_user_id;
  EXCEPTION WHEN OTHERS THEN
    v_landlord_listings := 0; v_verified_listings := 0;
  END;

  v_landlord_score := LEAST(5,
      (v_verified_listings * 1.0)
    + (v_landlord_listings * 0.3)
  );
  IF v_landlord_listings > 0 THEN
    v_data_points := v_data_points + 1;
  END IF;

  -- ============ PORTFOLIO (capacity & limit only — no longer scored separately) ============
  BEGIN
    SELECT COALESCE(SUM(COALESCE(investment_amount, principal_amount, 0)), 0)
      INTO v_portfolio_value
      FROM investor_portfolios
     WHERE (investor_id = v_user_id OR agent_id = v_user_id)
       AND status IN ('active', 'pending', 'pending_approval', 'matured');
  EXCEPTION WHEN OTHERS THEN v_portfolio_value := 0; END;

  IF v_portfolio_value >= 50000 THEN v_data_points := v_data_points + 2; END IF;

  -- ============ TOTAL ============
  v_trust_score := LEAST(100,
      v_payment_score + v_wallet_score + v_network_score
    + v_verification_score + v_behavior_score + v_landlord_score
  );

  v_tier := CASE
    WHEN v_data_points < 2 THEN 'new'
    WHEN v_trust_score >= 80 THEN 'excellent'
    WHEN v_trust_score >= 60 THEN 'good'
    WHEN v_trust_score >= 40 THEN 'standard'
    WHEN v_trust_score >= 25 THEN 'caution'
    ELSE 'high_risk'
  END;

  -- Borrowing limit factors in cash flow capacity
  v_borrowing_limit := GREATEST(
    CASE WHEN v_payments_count > 0 THEN v_total_paid * 0.5 ELSE 0 END,
    CASE WHEN v_portfolio_value >= 50000 THEN v_portfolio_value * 0.5 ELSE 0 END,
    CASE WHEN v_total_flow_90d > 0 THEN (v_total_flow_90d / 90) * 30 * 0.4 ELSE 0 END
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
      'score', ROUND(v_trust_score, 1),
      'tier', v_tier,
      'data_points', v_data_points,
      'borrowing_limit_ugx', v_borrowing_limit,
      'breakdown', jsonb_build_object(
        'payment', ROUND(v_payment_score, 1),
        'wallet', ROUND(v_wallet_score, 1),
        'network', ROUND(v_network_score, 1),
        'verification', ROUND(v_verification_score, 1),
        'behavior', ROUND(v_behavior_score, 1),
        'landlord', ROUND(v_landlord_score, 1)
      ),
      'weights', jsonb_build_object(
        'payment', 25, 'wallet', 20, 'network', 15,
        'verification', 15, 'behavior', 20, 'landlord', 5
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
    'cash_flow_capacity', jsonb_build_object(
      'daily_avg', CASE WHEN v_total_flow_90d > 0 THEN ROUND(v_total_flow_90d / 90, 0) ELSE 0 END,
      'weekly_avg', CASE WHEN v_total_flow_90d > 0 THEN ROUND(v_total_flow_90d / 90 * 7, 0) ELSE 0 END,
      'monthly_avg', CASE WHEN v_total_flow_90d > 0 THEN ROUND(v_total_flow_90d / 90 * 30, 0) ELSE 0 END,
      'inflow_30d', v_wallet_inflow_30d,
      'outflow_30d', v_wallet_outflow_30d,
      'window_days', 90
    ),
    'network', jsonb_build_object(
      'referrals', v_referrals_count,
      'sub_agents', v_sub_agents,
      'tenants_onboarded', v_tenants_onboarded,
      'portfolio_value', v_portfolio_value
    ),
    'behavior', jsonb_build_object(
      'visits_total_60d', v_visits_total,
      'worship_visits', v_visits_worship,
      'mall_visits', v_visits_mall,
      'restaurant_visits', v_visits_restaurant,
      'hotel_visits', v_visits_hotel,
      'shop_visits', v_visits_shop,
      'wallet_shopping_count', v_wallet_shop_count,
      'always_share_location', v_always_gps,
      'location_captures_30d', v_location_count_30d
    ),
    'landlord_activity', jsonb_build_object(
      'total_listings', v_landlord_listings,
      'verified_listings', v_verified_listings,
      'guaranteed_rent', v_verified_listings > 0
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

-- 4) Public version exposes new sections without PII
CREATE OR REPLACE FUNCTION public.get_public_trust_profile(p_ai_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_full jsonb;
BEGIN
  v_full := get_user_trust_profile(p_ai_id);
  IF v_full ? 'error' THEN RETURN v_full; END IF;

  RETURN jsonb_build_object(
    'ai_id', v_full->'ai_id',
    'identity', jsonb_build_object(
      'full_name', v_full->'identity'->'full_name',
      'avatar_url', v_full->'identity'->'avatar_url',
      'verified', v_full->'identity'->'verified',
      'member_since', v_full->'identity'->'member_since',
      'primary_role', v_full->'identity'->'primary_role',
      'national_id_present', v_full->'identity'->'national_id_present',
      'roles', v_full->'identity'->'roles'
    ),
    'trust', v_full->'trust',
    'payment_history', jsonb_build_object(
      'total_rent_plans', v_full->'payment_history'->'total_rent_plans',
      'on_time_rate', v_full->'payment_history'->'on_time_rate'
    ),
    'cash_flow_capacity', jsonb_build_object(
      'daily_avg', v_full->'cash_flow_capacity'->'daily_avg',
      'weekly_avg', v_full->'cash_flow_capacity'->'weekly_avg',
      'monthly_avg', v_full->'cash_flow_capacity'->'monthly_avg',
      'window_days', v_full->'cash_flow_capacity'->'window_days'
    ),
    'network', jsonb_build_object(
      'referrals', v_full->'network'->'referrals',
      'sub_agents', v_full->'network'->'sub_agents',
      'tenants_onboarded', v_full->'network'->'tenants_onboarded'
    ),
    'behavior', jsonb_build_object(
      'visits_total_60d', v_full->'behavior'->'visits_total_60d',
      'always_share_location', v_full->'behavior'->'always_share_location'
    ),
    'landlord_activity', v_full->'landlord_activity',
    'welile_vouches', true,
    'generated_at', NOW()
  );
END;
$function$;
