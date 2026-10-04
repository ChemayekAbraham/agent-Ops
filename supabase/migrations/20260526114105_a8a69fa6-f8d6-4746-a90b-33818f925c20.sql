CREATE OR REPLACE FUNCTION public.recompute_trust_score(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  SELECT
    COALESCE(p.managed_by_agent, false)
    OR p.managing_agent_id IS NOT NULL
    OR (p.email IS NULL AND p.phone IS NULL)
  INTO v_is_managed
  FROM public.profiles p
  WHERE p.id = p_user_id;

  BEGIN
    v_profile := public.get_user_trust_profile(v_ai_id);
  EXCEPTION WHEN OTHERS THEN
    v_profile := NULL;
  END;

  IF v_profile IS NOT NULL AND (v_profile->>'error') IS NULL THEN
    -- Cast via numeric first since score/data_points may come back as "1.0"
    v_score := COALESCE(FLOOR((v_profile->'trust'->>'score')::numeric)::int, 0);
    v_tier := COALESCE(v_profile->'trust'->>'tier', 'new');
    v_data_points := COALESCE(FLOOR((v_profile->'trust'->>'data_points')::numeric)::int, 0);
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
$function$;