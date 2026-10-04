
-- ==========================================================
-- 1. Mission completions table
-- ==========================================================
CREATE TABLE IF NOT EXISTS public.agent_mission_completions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL,
  mission_key TEXT NOT NULL,
  signals_captured INTEGER NOT NULL DEFAULT 1,
  commission_awarded NUMERIC NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amc_agent_completed ON public.agent_mission_completions(agent_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_amc_completed_at ON public.agent_mission_completions(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_amc_mission_key ON public.agent_mission_completions(mission_key);

ALTER TABLE public.agent_mission_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own mission completions"
  ON public.agent_mission_completions FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

CREATE POLICY "Agents insert own mission completions"
  ON public.agent_mission_completions FOR INSERT
  TO authenticated
  WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Staff view all mission completions"
  ON public.agent_mission_completions FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- ==========================================================
-- 2. get_agent_daily_missions — personalised mission list
-- ==========================================================
CREATE OR REPLACE FUNCTION public.get_agent_daily_missions(p_agent_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id UUID := COALESCE(p_agent_id, auth.uid());
  v_missions JSONB := '[]'::jsonb;
  v_managed_ids UUID[];
  v_missing_id_count INT;
  v_no_geo_count INT;
  v_no_income_count INT;
  v_stale_count INT;
  v_no_vouch_count INT;
  v_no_landlord_count INT;
  v_today_start TIMESTAMPTZ := date_trunc('day', now());
BEGIN
  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  -- Pull agent's managed user IDs (referrals + active assignments)
  SELECT array_agg(DISTINCT id)
    INTO v_managed_ids
  FROM (
    SELECT id FROM public.profiles WHERE referrer_id = v_agent_id
    UNION
    SELECT tenant_id AS id FROM public.agent_collections WHERE agent_id = v_agent_id AND created_at > now() - interval '90 days'
  ) m;

  IF v_managed_ids IS NULL OR array_length(v_managed_ids, 1) IS NULL THEN
    v_managed_ids := ARRAY[]::UUID[];
  END IF;

  -- Gap counts
  SELECT count(*) INTO v_missing_id_count
    FROM public.profiles
   WHERE id = ANY(v_managed_ids) AND (national_id IS NULL OR national_id = '');

  SELECT count(*) INTO v_no_geo_count
    FROM public.profiles p
   WHERE p.id = ANY(v_managed_ids)
     AND NOT EXISTS (
       SELECT 1 FROM public.venue_visits vv
        WHERE vv.user_id = p.id AND vv.visited_at > now() - interval '30 days'
     );

  SELECT count(*) INTO v_no_income_count
    FROM public.profiles
   WHERE id = ANY(v_managed_ids)
     AND (monthly_income IS NULL OR monthly_income = 0);

  SELECT count(*) INTO v_stale_count
    FROM public.profiles p
   WHERE p.id = ANY(v_managed_ids)
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_visits av
        WHERE av.tenant_id = p.id AND av.checked_in_at > now() - interval '60 days'
     );

  SELECT count(*) INTO v_no_vouch_count
    FROM public.profiles p
   WHERE p.id = ANY(v_managed_ids)
     AND NOT EXISTS (
       SELECT 1 FROM public.audit_logs al
        WHERE al.record_id::text = p.id::text
          AND al.metadata->>'signal_type' = 'quick_vouch'
     );

  SELECT count(*) INTO v_no_landlord_count
    FROM public.profiles p
   WHERE p.id = ANY(v_managed_ids)
     AND NOT EXISTS (
       SELECT 1 FROM public.audit_logs al
        WHERE al.record_id::text = p.id::text
          AND al.metadata->>'signal_type' = 'landlord_intro'
     );

  -- Build mission cards
  v_missions := jsonb_build_array(
    jsonb_build_object(
      'key', 'snap_ids',
      'title', 'Snap National IDs',
      'tagline', '📸 Capture ID photos for verification',
      'signal_type', 'id_verified',
      'target', LEAST(5, v_missing_id_count),
      'gap_total', v_missing_id_count,
      'points_per_signal', 5,
      'commission_per_signal', 1000,
      'icon', 'IdCard',
      'color', 'violet',
      'priority', CASE WHEN v_missing_id_count >= 5 THEN 'high' ELSE 'medium' END
    ),
    jsonb_build_object(
      'key', 'geo_tag_homes',
      'title', 'Geo-tag Homes',
      'tagline', '📍 Pin 10 home locations on the map',
      'signal_type', 'venue_visit',
      'target', LEAST(10, v_no_geo_count),
      'gap_total', v_no_geo_count,
      'points_per_signal', 3,
      'commission_per_signal', 500,
      'icon', 'MapPin',
      'color', 'blue',
      'priority', CASE WHEN v_no_geo_count >= 10 THEN 'high' ELSE 'medium' END
    ),
    jsonb_build_object(
      'key', 'salary_proof',
      'title', 'Add Salary Proof',
      'tagline', '💼 Capture income evidence for 3 users',
      'signal_type', 'salary_proof',
      'target', LEAST(3, v_no_income_count),
      'gap_total', v_no_income_count,
      'points_per_signal', 8,
      'commission_per_signal', 1000,
      'icon', 'Briefcase',
      'color', 'rose',
      'priority', CASE WHEN v_no_income_count >= 3 THEN 'high' ELSE 'low' END
    ),
    jsonb_build_object(
      'key', 'vouch_users',
      'title', 'Vouch for Users',
      'tagline', '🤝 Submit a character vouch for 2 users',
      'signal_type', 'quick_vouch',
      'target', LEAST(2, v_no_vouch_count),
      'gap_total', v_no_vouch_count,
      'points_per_signal', 6,
      'commission_per_signal', 800,
      'icon', 'CheckCircle2',
      'color', 'emerald',
      'priority', 'medium'
    ),
    jsonb_build_object(
      'key', 'landlord_intro',
      'title', 'Landlord Introductions',
      'tagline', '🏠 Connect 2 users to their landlords',
      'signal_type', 'landlord_intro',
      'target', LEAST(2, v_no_landlord_count),
      'gap_total', v_no_landlord_count,
      'points_per_signal', 5,
      'commission_per_signal', 700,
      'icon', 'Home',
      'color', 'amber',
      'priority', 'low'
    ),
    jsonb_build_object(
      'key', 'reverify_stale',
      'title', 'Re-verify Stale Profiles',
      'tagline', '🔄 Touch base with 5 inactive users',
      'signal_type', 'venue_visit',
      'target', LEAST(5, v_stale_count),
      'gap_total', v_stale_count,
      'points_per_signal', 2,
      'commission_per_signal', 300,
      'icon', 'Users',
      'color', 'slate',
      'priority', 'low'
    )
  );

  -- Append today's progress per mission
  RETURN jsonb_build_object(
    'agent_id', v_agent_id,
    'managed_user_count', COALESCE(array_length(v_managed_ids, 1), 0),
    'missions', v_missions,
    'completions_today', (
      SELECT COALESCE(jsonb_object_agg(mission_key, c), '{}'::jsonb)
      FROM (
        SELECT mission_key, count(*) AS c
        FROM public.agent_mission_completions
        WHERE agent_id = v_agent_id AND completed_at >= v_today_start
        GROUP BY mission_key
      ) t
    ),
    'generated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_daily_missions(UUID) TO authenticated;

-- ==========================================================
-- 3. get_agent_mission_stats — streak, quota, rank
-- ==========================================================
CREATE OR REPLACE FUNCTION public.get_agent_mission_stats(p_agent_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id UUID := COALESCE(p_agent_id, auth.uid());
  v_today_start TIMESTAMPTZ := date_trunc('day', now());
  v_week_start TIMESTAMPTZ := date_trunc('week', now());
  v_signals_today INT;
  v_signals_week INT;
  v_streak INT := 0;
  v_check_date DATE := CURRENT_DATE;
  v_has_capture BOOLEAN;
  v_rank INT;
  v_tier TEXT;
BEGIN
  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  SELECT count(*) INTO v_signals_today
    FROM public.agent_mission_completions
   WHERE agent_id = v_agent_id AND completed_at >= v_today_start;

  SELECT count(*) INTO v_signals_week
    FROM public.agent_mission_completions
   WHERE agent_id = v_agent_id AND completed_at >= v_week_start;

  -- Streak: count consecutive days with at least one capture, walking backwards
  LOOP
    SELECT EXISTS(
      SELECT 1 FROM public.agent_mission_completions
       WHERE agent_id = v_agent_id
         AND completed_at >= v_check_date::timestamptz
         AND completed_at < (v_check_date + 1)::timestamptz
    ) INTO v_has_capture;
    EXIT WHEN NOT v_has_capture OR v_streak > 365;
    v_streak := v_streak + 1;
    v_check_date := v_check_date - 1;
  END LOOP;

  -- Weekly rank
  SELECT rnk INTO v_rank FROM (
    SELECT agent_id, rank() OVER (ORDER BY count(*) DESC) AS rnk
    FROM public.agent_mission_completions
    WHERE completed_at >= v_week_start
    GROUP BY agent_id
  ) t WHERE agent_id = v_agent_id;

  v_tier := CASE
    WHEN v_signals_week >= 100 THEN 'diamond'
    WHEN v_signals_week >= 50 THEN 'gold'
    WHEN v_signals_week >= 20 THEN 'silver'
    WHEN v_signals_week >= 5 THEN 'bronze'
    ELSE 'starter'
  END;

  RETURN jsonb_build_object(
    'agent_id', v_agent_id,
    'signals_today', v_signals_today,
    'daily_quota', 10,
    'signals_this_week', v_signals_week,
    'current_streak_days', v_streak,
    'weekly_rank', COALESCE(v_rank, 0),
    'tier', v_tier,
    'generated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_mission_stats(UUID) TO authenticated;

-- ==========================================================
-- 4. get_mission_leaderboard — top capturers this week
-- ==========================================================
CREATE OR REPLACE FUNCTION public.get_mission_leaderboard(p_limit INT DEFAULT 10)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_week_start TIMESTAMPTZ := date_trunc('week', now());
  v_result JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'agent_id', amc.agent_id,
      'full_name', COALESCE(p.full_name, 'Agent'),
      'avatar_url', p.avatar_url,
      'territory', p.territory,
      'signals', count(*),
      'commission_earned', sum(amc.commission_awarded),
      'rank', rank() OVER (ORDER BY count(*) DESC)
    ) AS row
    FROM public.agent_mission_completions amc
    LEFT JOIN public.profiles p ON p.id = amc.agent_id
    WHERE amc.completed_at >= v_week_start
    GROUP BY amc.agent_id, p.full_name, p.avatar_url, p.territory
    ORDER BY count(*) DESC
    LIMIT GREATEST(p_limit, 1)
  ) sub;

  RETURN jsonb_build_object(
    'week_start', v_week_start,
    'leaderboard', v_result,
    'generated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_mission_leaderboard(INT) TO authenticated;
