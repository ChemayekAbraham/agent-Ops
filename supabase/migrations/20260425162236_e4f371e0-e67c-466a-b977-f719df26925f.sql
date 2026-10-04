-- =====================================================================
-- Auto-growing agent vouch limit driven by field collections.
-- =====================================================================
-- Reuses welile_trust_score_cache (existing Vouch Network surface).
-- Adds an additive `agent_earned_vouch_ugx` column so we never clobber
-- the trust-engine-computed `borrowing_limit_ugx`.
--
-- Effective vouch limit (read via get_agent_vouch_limit_ugx) =
--   GREATEST(borrowing_limit_ugx, 100_000) + agent_earned_vouch_ugx
--
-- The 100k floor is applied at READ time so every agent gets it
-- automatically with no row-by-row backfill required.
-- =====================================================================

-- 1) Storage: additive earned-vouch column on the trust cache.
ALTER TABLE public.welile_trust_score_cache
  ADD COLUMN IF NOT EXISTS agent_earned_vouch_ugx numeric NOT NULL DEFAULT 0
    CHECK (agent_earned_vouch_ugx >= 0);

COMMENT ON COLUMN public.welile_trust_score_cache.agent_earned_vouch_ugx IS
  'Cumulative vouch growth earned by an agent from field collections. '
  'Computed as 2 * SUM(agent_collections.amount). Maintained by '
  'trg_agent_collection_recompute_vouch on public.agent_collections.';

-- 2) Constants: keep magic numbers in one place for future tuning.
CREATE OR REPLACE FUNCTION public.welile_default_agent_vouch_floor_ugx()
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT 100000::numeric $$;

CREATE OR REPLACE FUNCTION public.welile_agent_vouch_multiplier()
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT 2::numeric $$;

-- 3) Recompute function — idempotent, source-of-truth = live SUM.
--    Called by the trigger AFTER any insert/update/delete on
--    agent_collections, so reversals shrink the limit correctly.
CREATE OR REPLACE FUNCTION public.recompute_agent_earned_vouch(p_agent_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_earned numeric;
  v_ai_id  text;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Live recompute from collections (NULL-safe, COALESCE to 0).
  SELECT public.welile_agent_vouch_multiplier() * COALESCE(SUM(amount), 0)
    INTO v_earned
    FROM public.agent_collections
   WHERE agent_id = p_agent_id;

  -- Upsert into the trust cache. We need an ai_id for the row even if
  -- the trust-score engine has never run for this agent yet.
  v_ai_id := public.derive_welile_ai_id(p_agent_id);

  INSERT INTO public.welile_trust_score_cache
    (user_id, ai_id, score, tier, data_points, borrowing_limit_ugx,
     breakdown, is_agent_managed, agent_earned_vouch_ugx, last_calculated_at)
  VALUES
    (p_agent_id, v_ai_id, 0, 'new', 0, 0,
     '{}'::jsonb, false, v_earned, now())
  ON CONFLICT (user_id) DO UPDATE
    SET agent_earned_vouch_ugx = EXCLUDED.agent_earned_vouch_ugx,
        last_calculated_at     = now();

  RETURN v_earned;
END;
$$;

-- 4) Public read accessor — applies the 100k floor + adds earned growth.
--    Use this everywhere you display an agent's vouch limit. Single
--    source of truth means the floor and multiplier can change without
--    touching call sites.
CREATE OR REPLACE FUNCTION public.get_agent_vouch_limit_ugx(p_agent_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
           COALESCE(c.borrowing_limit_ugx, 0),
           public.welile_default_agent_vouch_floor_ugx()
         )
       + COALESCE(c.agent_earned_vouch_ugx, 0)
    FROM (
      SELECT borrowing_limit_ugx, agent_earned_vouch_ugx
        FROM public.welile_trust_score_cache
       WHERE user_id = p_agent_id
      UNION ALL
      -- Fallback row for agents who don't have a cache entry yet, so
      -- they still get the 100k floor immediately on signup.
      SELECT 0::numeric, 0::numeric
       LIMIT 1
    ) c
   ORDER BY (c.borrowing_limit_ugx + c.agent_earned_vouch_ugx) DESC NULLS LAST
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_vouch_limit_ugx(uuid)
  TO authenticated, anon;

-- 5) Trigger function: route every collection mutation to the recompute.
--    Also captures a Trust Mission signal on INSERT so the
--    AGENT FIELD MANDATE rule (every agent action contributes to trust)
--    stays satisfied. Trust signal is best-effort — failure must NOT
--    block the underlying collection write.
CREATE OR REPLACE FUNCTION public.trg_recompute_agent_vouch_on_collection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.recompute_agent_earned_vouch(NEW.agent_id);

    -- Best-effort trust signal — never block the collection.
    BEGIN
      PERFORM public.capture_trust_signal(
        NEW.agent_id,
        'field_collection',
        jsonb_build_object(
          'collection_id', NEW.id,
          'amount',        NEW.amount,
          'tenant_id',     NEW.tenant_id,
          'visit_id',      NEW.visit_id
        )
      );
    EXCEPTION WHEN OTHERS THEN
      -- Swallow: trust signal is observability, not correctness.
      NULL;
    END;

    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Recompute for both sides if the agent_id moved (rare but possible
    -- under admin correction), otherwise just for the (unchanged) agent.
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
      PERFORM public.recompute_agent_earned_vouch(OLD.agent_id);
    END IF;
    PERFORM public.recompute_agent_earned_vouch(NEW.agent_id);
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.recompute_agent_earned_vouch(OLD.agent_id);
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_collection_recompute_vouch
  ON public.agent_collections;

CREATE TRIGGER trg_agent_collection_recompute_vouch
AFTER INSERT OR UPDATE OF amount, agent_id OR DELETE
ON public.agent_collections
FOR EACH ROW
EXECUTE FUNCTION public.trg_recompute_agent_vouch_on_collection();

-- 6) One-time backfill: recompute for every agent that has historical
--    collections, so existing field activity lights up immediately.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT agent_id
      FROM public.agent_collections
     WHERE agent_id IS NOT NULL
  LOOP
    PERFORM public.recompute_agent_earned_vouch(r.agent_id);
  END LOOP;
END $$;