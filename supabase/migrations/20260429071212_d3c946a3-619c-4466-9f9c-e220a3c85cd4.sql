-- Fix: column "updated_at" of relation "welile_trust_score_cache" does not exist
-- The 4-arg overload of recompute_agent_earned_vouch and the agent_collections
-- trigger were both broken. Rebuild both atomically against the live backend.

CREATE OR REPLACE FUNCTION public.recompute_agent_earned_vouch(
  p_agent_id uuid,
  p_change_source text DEFAULT 'manual_recompute'::text,
  p_collection_id uuid DEFAULT NULL::uuid,
  p_collection_amount numeric DEFAULT NULL::numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total_collected numeric := 0;
  v_new_earned numeric := 0;
  v_prev_earned numeric := 0;
  v_prev_effective numeric := 0;
  v_new_effective numeric := 0;
  v_min numeric := public.welile_agent_vouch_min_ugx();
  v_max numeric := public.welile_agent_vouch_max_ugx();
  v_already_logged boolean := false;
  v_ai_id text;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN;
  END IF;

  IF p_change_source NOT IN ('collection_insert','collection_update','collection_delete','manual_recompute','backfill') THEN
    RAISE EXCEPTION 'Invalid change_source: %', p_change_source;
  END IF;

  IF p_collection_amount IS NOT NULL AND p_collection_amount < 0 THEN
    RAISE EXCEPTION 'collection_amount must be non-negative, got: %', p_collection_amount;
  END IF;

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
  v_new_earned := GREATEST(v_min, LEAST(v_max, v_new_earned));

  -- ai_id required for fresh insert
  v_ai_id := public.derive_welile_ai_id(p_agent_id);

  INSERT INTO public.welile_trust_score_cache
    (user_id, ai_id, score, tier, data_points, borrowing_limit_ugx,
     breakdown, is_agent_managed, agent_earned_vouch_ugx, last_calculated_at)
  VALUES
    (p_agent_id, v_ai_id, 0, 'new', 0, 0,
     '{}'::jsonb, false, v_new_earned, now())
  ON CONFLICT (user_id) DO UPDATE
    SET agent_earned_vouch_ugx = EXCLUDED.agent_earned_vouch_ugx,
        last_calculated_at     = now();

  v_new_effective := public.get_agent_vouch_limit_ugx(p_agent_id);
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
      RAISE NOTICE 'Race-detected duplicate audit for collection % (source %), skipping', p_collection_id, p_change_source;
    END;
  END IF;
END;
$function$;

-- Rebuild trigger: never block a collection insert on a trust-signal failure,
-- and use the correct capture_trust_signal signature.
CREATE OR REPLACE FUNCTION public.trg_recompute_agent_vouch_on_collection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.recompute_agent_earned_vouch(NEW.agent_id, 'collection_insert', NEW.id, NEW.amount);
    -- Best-effort trust signal; observability must never block a payment.
    BEGIN
      PERFORM public.capture_trust_signal(
        NEW.tenant_id,
        'rent_payment',
        'other',
        COALESCE(NEW.location_name, 'agent_collection'),
        0::double precision,
        0::double precision,
        NULL::double precision,
        format('collection:%s amount:%s', NEW.id, NEW.amount)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM public.recompute_agent_earned_vouch(NEW.agent_id, 'collection_update', NEW.id, NEW.amount);
    IF OLD.agent_id IS DISTINCT FROM NEW.agent_id THEN
      PERFORM public.recompute_agent_earned_vouch(OLD.agent_id, 'collection_update', NEW.id, OLD.amount);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.recompute_agent_earned_vouch(OLD.agent_id, 'collection_delete', OLD.id, OLD.amount);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;