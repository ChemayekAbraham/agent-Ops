-- Welile Trust Score Cache: ensure every profile has a score
CREATE TABLE IF NOT EXISTS public.welile_trust_score_cache (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  ai_id text NOT NULL,
  score integer NOT NULL DEFAULT 0,
  tier text NOT NULL DEFAULT 'new',
  data_points integer NOT NULL DEFAULT 0,
  borrowing_limit_ugx numeric NOT NULL DEFAULT 0,
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_agent_managed boolean NOT NULL DEFAULT false,
  last_calculated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trust_cache_score ON public.welile_trust_score_cache(score DESC);
CREATE INDEX IF NOT EXISTS idx_trust_cache_tier ON public.welile_trust_score_cache(tier);
CREATE INDEX IF NOT EXISTS idx_trust_cache_last_calc ON public.welile_trust_score_cache(last_calculated_at);
CREATE INDEX IF NOT EXISTS idx_trust_cache_data_points ON public.welile_trust_score_cache(data_points DESC);

ALTER TABLE public.welile_trust_score_cache ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read aggregate score data (tier/score is shareable, lender-facing)
DROP POLICY IF EXISTS "Authenticated can read trust cache" ON public.welile_trust_score_cache;
CREATE POLICY "Authenticated can read trust cache"
ON public.welile_trust_score_cache
FOR SELECT
TO authenticated
USING (true);

-- Only service role / SECURITY DEFINER functions can write
DROP POLICY IF EXISTS "Service role writes trust cache" ON public.welile_trust_score_cache;
CREATE POLICY "Service role writes trust cache"
ON public.welile_trust_score_cache
FOR ALL
TO service_role
USING (true) WITH CHECK (true);

-- Helper: derive AI ID from user_id (mirror of generateWelileAiId in TS)
CREATE OR REPLACE FUNCTION public.derive_welile_ai_id(p_user_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT 'WEL-' || upper(substring(replace(p_user_id::text, '-', ''), 1, 6));
$$;

-- Recompute one user's trust score and upsert into cache
-- Uses the existing get_user_trust_profile RPC under SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.recompute_trust_score(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ai_id text;
  v_profile jsonb;
  v_score integer := 0;
  v_tier text := 'new';
  v_data_points integer := 0;
  v_borrow numeric := 0;
  v_breakdown jsonb := '{}'::jsonb;
  v_is_managed boolean := false;
BEGIN
  v_ai_id := public.derive_welile_ai_id(p_user_id);

  -- Detect agent-managed: profile lacks email/phone or marked managed
  SELECT (p.is_managed_account IS TRUE) OR (p.email IS NULL AND p.phone IS NULL)
    INTO v_is_managed
  FROM public.profiles p WHERE p.id = p_user_id;

  -- Try to fetch holistic profile
  BEGIN
    v_profile := public.get_user_trust_profile(v_ai_id);
  EXCEPTION WHEN OTHERS THEN
    v_profile := NULL;
  END;

  IF v_profile IS NOT NULL AND (v_profile->>'error') IS NULL THEN
    v_score := COALESCE((v_profile->'trust'->>'score')::int, 0);
    v_tier := COALESCE(v_profile->'trust'->>'tier', 'new');
    v_data_points := COALESCE((v_profile->'trust'->>'data_points')::int, 0);
    v_borrow := COALESCE((v_profile->'trust'->>'borrowing_limit_ugx')::numeric, 0);
    v_breakdown := COALESCE(v_profile->'trust'->'breakdown', '{}'::jsonb);
  END IF;

  INSERT INTO public.welile_trust_score_cache
    (user_id, ai_id, score, tier, data_points, borrowing_limit_ugx, breakdown, is_agent_managed, last_calculated_at)
  VALUES
    (p_user_id, v_ai_id, v_score, v_tier, v_data_points, v_borrow, v_breakdown, COALESCE(v_is_managed, false), now())
  ON CONFLICT (user_id) DO UPDATE SET
    ai_id = EXCLUDED.ai_id,
    score = EXCLUDED.score,
    tier = EXCLUDED.tier,
    data_points = EXCLUDED.data_points,
    borrowing_limit_ugx = EXCLUDED.borrowing_limit_ugx,
    breakdown = EXCLUDED.breakdown,
    is_agent_managed = EXCLUDED.is_agent_managed,
    last_calculated_at = now();
END;
$$;

-- Batch recompute: process N stale users at a time (nightly cron paginator)
CREATE OR REPLACE FUNCTION public.recompute_trust_scores_batch(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_processed integer := 0;
  v_errors integer := 0;
BEGIN
  FOR v_user_id IN
    SELECT p.id
    FROM public.profiles p
    LEFT JOIN public.welile_trust_score_cache c ON c.user_id = p.id
    ORDER BY COALESCE(c.last_calculated_at, '1970-01-01'::timestamptz) ASC
    LIMIT p_limit
  LOOP
    BEGIN
      PERFORM public.recompute_trust_score(v_user_id);
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      -- still seed an empty row so coverage is 100%
      INSERT INTO public.welile_trust_score_cache (user_id, ai_id, last_calculated_at)
      VALUES (v_user_id, public.derive_welile_ai_id(v_user_id), now())
      ON CONFLICT (user_id) DO UPDATE SET last_calculated_at = now();
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'errors', v_errors,
    'limit', p_limit,
    'completed_at', now()
  );
END;
$$;

-- Coverage stats RPC (for CEO dashboard)
CREATE OR REPLACE FUNCTION public.get_trust_coverage_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_profiles integer;
  v_with_score integer;
  v_avg_score numeric;
  v_avg_data_points numeric;
  v_lender_ready integer;
  v_tier_dist jsonb;
  v_signals_7d integer;
  v_active_agents_7d integer;
BEGIN
  SELECT COUNT(*) INTO v_total_profiles FROM public.profiles;
  SELECT COUNT(*), COALESCE(AVG(score), 0), COALESCE(AVG(data_points), 0)
    INTO v_with_score, v_avg_score, v_avg_data_points
  FROM public.welile_trust_score_cache;

  SELECT COUNT(*) INTO v_lender_ready
  FROM public.welile_trust_score_cache
  WHERE score >= 60 AND data_points >= 5;

  SELECT COALESCE(jsonb_object_agg(tier, cnt), '{}'::jsonb) INTO v_tier_dist
  FROM (
    SELECT tier, COUNT(*) AS cnt
    FROM public.welile_trust_score_cache
    GROUP BY tier
  ) t;

  SELECT COUNT(*) INTO v_signals_7d
  FROM public.agent_visits
  WHERE checked_in_at >= now() - interval '7 days';

  SELECT COUNT(DISTINCT agent_id) INTO v_active_agents_7d
  FROM public.agent_visits
  WHERE checked_in_at >= now() - interval '7 days';

  RETURN jsonb_build_object(
    'total_profiles', v_total_profiles,
    'with_score', v_with_score,
    'coverage_pct', CASE WHEN v_total_profiles > 0 THEN round((v_with_score::numeric / v_total_profiles) * 100, 1) ELSE 0 END,
    'avg_score', round(v_avg_score, 1),
    'avg_data_points', round(v_avg_data_points, 2),
    'lender_ready', v_lender_ready,
    'tier_distribution', v_tier_dist,
    'agent_signals_7d', v_signals_7d,
    'active_agents_7d', v_active_agents_7d,
    'capture_rate_per_agent_7d', CASE WHEN v_active_agents_7d > 0 THEN round(v_signals_7d::numeric / v_active_agents_7d, 1) ELSE 0 END,
    'generated_at', now()
  );
END;
$$;

-- Allow authenticated to call coverage stats
GRANT EXECUTE ON FUNCTION public.get_trust_coverage_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_trust_score(uuid) TO authenticated;

-- Trust capture: agent records a behavioural signal in one shot
-- Writes to agent_visits + venue_visits + audit_logs and re-scores the user
CREATE OR REPLACE FUNCTION public.capture_trust_signal(
  p_tenant_id uuid,
  p_signal_type text,         -- rent_payment | venue_visit | id_verified | landlord_intro | salary_proof | quick_vouch
  p_venue_category text,      -- worship | mall | restaurant | hotel | shop | market | residence | other
  p_venue_name text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id uuid := auth.uid();
  v_visit_id uuid;
  v_venue_id uuid;
BEGIN
  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  IF p_tenant_id IS NULL OR p_signal_type IS NULL OR p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION 'missing_fields';
  END IF;

  -- 1. Agent visit row (geo-stamped)
  INSERT INTO public.agent_visits (agent_id, tenant_id, latitude, longitude, accuracy, location_name, checked_in_at)
  VALUES (v_agent_id, p_tenant_id, p_latitude, p_longitude, p_accuracy, p_venue_name, now())
  RETURNING id INTO v_visit_id;

  -- 2. Venue visit row (behavior signal)
  INSERT INTO public.venue_visits
    (user_id, category, venue_name, latitude, longitude, accuracy, visited_at, source)
  VALUES
    (p_tenant_id, COALESCE(p_venue_category, 'other'), COALESCE(p_venue_name, p_signal_type),
     p_latitude, p_longitude, p_accuracy, now(), 'agent_capture')
  RETURNING id INTO v_venue_id;

  -- 3. Audit log
  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata, reason)
  VALUES (
    'trust_signal_capture',
    'venue_visits',
    v_venue_id,
    v_agent_id,
    jsonb_build_object(
      'signal_type', p_signal_type,
      'tenant_id', p_tenant_id,
      'venue', p_venue_name,
      'category', p_venue_category,
      'notes', p_notes
    ),
    'agent_field_capture'
  );

  -- 4. Recompute the tenant's trust score immediately
  PERFORM public.recompute_trust_score(p_tenant_id);

  RETURN jsonb_build_object(
    'success', true,
    'agent_visit_id', v_visit_id,
    'venue_visit_id', v_venue_id,
    'signal_type', p_signal_type
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.capture_trust_signal(uuid, text, text, text, double precision, double precision, double precision, text) TO authenticated;