-- 1. Audit table
CREATE TABLE IF NOT EXISTS public.agent_vouch_limit_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  change_source text NOT NULL CHECK (change_source IN ('collection_insert','collection_update','collection_delete','manual_recompute','backfill')),
  collection_id uuid,
  collection_amount numeric,
  previous_earned_ugx numeric,
  new_earned_ugx numeric,
  previous_effective_limit_ugx numeric,
  new_effective_limit_ugx numeric,
  delta_ugx numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_avlh_agent_created
  ON public.agent_vouch_limit_history (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_avlh_collection
  ON public.agent_vouch_limit_history (collection_id);

ALTER TABLE public.agent_vouch_limit_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents read own vouch audit"
  ON public.agent_vouch_limit_history
  FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

CREATE POLICY "Senior staff read all vouch audit"
  ON public.agent_vouch_limit_history
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'manager')
  );

CREATE POLICY "Block client inserts"
  ON public.agent_vouch_limit_history
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

-- 2. Recompute function with audit + extra params
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
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN;
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

  INSERT INTO public.welile_trust_score_cache (user_id, agent_earned_vouch_ugx, updated_at)
  VALUES (p_agent_id, v_new_earned, now())
  ON CONFLICT (user_id) DO UPDATE
    SET agent_earned_vouch_ugx = EXCLUDED.agent_earned_vouch_ugx,
        updated_at = now();

  v_new_effective := public.get_agent_vouch_limit_ugx(p_agent_id);

  IF v_prev_earned IS DISTINCT FROM v_new_earned
     OR p_collection_id IS NOT NULL THEN
    INSERT INTO public.agent_vouch_limit_history (
      agent_id, change_source, collection_id, collection_amount,
      previous_earned_ugx, new_earned_ugx,
      previous_effective_limit_ugx, new_effective_limit_ugx,
      delta_ugx
    ) VALUES (
      p_agent_id, p_change_source, p_collection_id, p_collection_amount,
      v_prev_earned, v_new_earned,
      v_prev_effective, v_new_effective,
      v_new_effective - v_prev_effective
    );
  END IF;
END;
$$;

-- 3. Trigger function passes source + metadata
CREATE OR REPLACE FUNCTION public.trg_recompute_agent_vouch_on_collection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.recompute_agent_earned_vouch(NEW.agent_id, 'collection_insert', NEW.id, NEW.amount);
    PERFORM public.capture_trust_signal('field_collection', NEW.agent_id, jsonb_build_object('amount', NEW.amount, 'collection_id', NEW.id));
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
$$;