-- Guardrails for vouch-limit updates
-- 1. Idempotency: prevent duplicate audit rows for the same (collection_id, change_source)
--    Only enforce when collection_id IS NOT NULL (manual recomputes can repeat)

-- Remove any existing duplicates first (keep earliest per collection+source)
DELETE FROM public.agent_vouch_limit_history a
USING public.agent_vouch_limit_history b
WHERE a.id > b.id
  AND a.collection_id IS NOT NULL
  AND a.collection_id = b.collection_id
  AND a.change_source = b.change_source;

CREATE UNIQUE INDEX IF NOT EXISTS uq_avlh_collection_source
  ON public.agent_vouch_limit_history (collection_id, change_source)
  WHERE collection_id IS NOT NULL
    AND change_source IN ('collection_insert','collection_delete');

-- 2. Min/Max caps + validation constants
CREATE OR REPLACE FUNCTION public.welile_agent_vouch_min_ugx()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0::numeric $$;

CREATE OR REPLACE FUNCTION public.welile_agent_vouch_max_ugx()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 30000000::numeric $$;

-- 3. Hardened recompute with validation, caps, and idempotency
CREATE OR REPLACE FUNCTION public.recompute_agent_earned_vouch(
  p_agent_id uuid,
  p_change_source text DEFAULT 'manual_recompute',
  p_collection_id uuid DEFAULT NULL,
  p_collection_amount numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_collected numeric := 0;
  v_new_earned numeric := 0;
  v_prev_earned numeric := 0;
  v_prev_effective numeric := 0;
  v_new_effective numeric := 0;
  v_min numeric := public.welile_agent_vouch_min_ugx();
  v_max numeric := public.welile_agent_vouch_max_ugx();
  v_already_logged boolean := false;
BEGIN
  -- Validation
  IF p_agent_id IS NULL THEN
    RETURN;
  END IF;

  IF p_change_source NOT IN ('collection_insert','collection_update','collection_delete','manual_recompute','backfill') THEN
    RAISE EXCEPTION 'Invalid change_source: %', p_change_source;
  END IF;

  IF p_collection_amount IS NOT NULL AND p_collection_amount < 0 THEN
    RAISE EXCEPTION 'collection_amount must be non-negative, got: %', p_collection_amount;
  END IF;

  -- Idempotency: skip if this collection+source already logged (insert/delete only)
  IF p_collection_id IS NOT NULL
     AND p_change_source IN ('collection_insert','collection_delete') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.agent_vouch_limit_history
       WHERE collection_id = p_collection_id
         AND change_source = p_change_source
    ) INTO v_already_logged;

    IF v_already_logged THEN
      RAISE NOTICE 'Vouch update already applied for collection % (source %)', p_collection_id, p_change_source;
      RETURN;
    END IF;
  END IF;

  SELECT COALESCE(agent_earned_vouch_ugx, 0)
    INTO v_prev_earned
    FROM public.welile_trust_score_cache
   WHERE user_id = p_agent_id;

  v_prev_earned := COALESCE(v_prev_earned, 0);
  v_prev_effective := public.get_agent_vouch_limit_ugx(p_agent_id);

  SELECT COALESCE(SUM(amount), 0)
    INTO v_total_collected
    FROM public.agent_collections
   WHERE agent_id = p_agent_id;

  v_new_earned := v_total_collected * public.welile_agent_vouch_multiplier();

  -- Apply min/max caps
  v_new_earned := GREATEST(v_min, LEAST(v_max, v_new_earned));

  INSERT INTO public.welile_trust_score_cache (user_id, agent_earned_vouch_ugx, updated_at)
  VALUES (p_agent_id, v_new_earned, now())
  ON CONFLICT (user_id) DO UPDATE
    SET agent_earned_vouch_ugx = EXCLUDED.agent_earned_vouch_ugx,
        updated_at = now();

  v_new_effective := public.get_agent_vouch_limit_ugx(p_agent_id);
  -- Cap effective limit too
  v_new_effective := GREATEST(v_min, LEAST(v_max, v_new_effective));

  IF v_prev_earned IS DISTINCT FROM v_new_earned
     OR p_collection_id IS NOT NULL THEN
    BEGIN
      INSERT INTO public.agent_vouch_limit_history (
        agent_id, change_source, collection_id, collection_amount,
        previous_earned_ugx, new_earned_ugx,
        previous_effective_limit_ugx, new_effective_limit_ugx,
        delta_ugx,
        metadata
      ) VALUES (
        p_agent_id, p_change_source, p_collection_id, p_collection_amount,
        v_prev_earned, v_new_earned,
        v_prev_effective, v_new_effective,
        v_new_effective - v_prev_effective,
        jsonb_build_object(
          'min_cap_ugx', v_min,
          'max_cap_ugx', v_max,
          'capped', (v_new_earned = v_max)
        )
      );
    EXCEPTION WHEN unique_violation THEN
      -- Race-condition safety: another session logged this same event
      RAISE NOTICE 'Race-detected duplicate audit for collection % (source %), skipping', p_collection_id, p_change_source;
    END;
  END IF;
END;
$$;