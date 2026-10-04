CREATE OR REPLACE FUNCTION public.get_agent_earned_vouch_in_range(
  p_ai_id    text,
  p_start_at timestamptz DEFAULT NULL,
  p_end_at   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id   uuid;
  v_collected  numeric := 0;
  v_count      integer := 0;
  v_multiplier integer := 2;
  v_floor_ugx  numeric := 100000;
  v_end        timestamptz := COALESCE(p_end_at, now());
BEGIN
  SELECT user_id INTO v_agent_id
    FROM public.welile_trust_score_cache
   WHERE ai_id = upper(trim(p_ai_id))
   LIMIT 1;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object(
      'found', false,
      'collected_ugx', 0,
      'earned_vouch_ugx', 0,
      'collection_count', 0,
      'multiplier', v_multiplier,
      'floor_ugx', v_floor_ugx
    );
  END IF;

  SELECT COALESCE(SUM(amount), 0), COUNT(*)
    INTO v_collected, v_count
    FROM public.agent_collections
   WHERE agent_id = v_agent_id
     AND created_at <  v_end
     AND (p_start_at IS NULL OR created_at >= p_start_at);

  RETURN jsonb_build_object(
    'found',            true,
    'collected_ugx',    v_collected,
    'earned_vouch_ugx', v_collected * v_multiplier,
    'collection_count', v_count,
    'multiplier',       v_multiplier,
    'floor_ugx',        v_floor_ugx,
    'window_start',     p_start_at,
    'window_end',       v_end
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_earned_vouch_in_range(text, timestamptz, timestamptz)
  TO anon, authenticated;