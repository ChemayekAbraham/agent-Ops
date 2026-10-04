-- 1. New profile columns (idempotent, additive only)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS continent text,
  ADD COLUMN IF NOT EXISTS town text,
  ADD COLUMN IF NOT EXISTS primary_persona text,
  ADD COLUMN IF NOT EXISTS occupation text,
  ADD COLUMN IF NOT EXISTS address_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS address_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS referrer_override_at timestamptz,
  ADD COLUMN IF NOT EXISTS referrer_locked boolean NOT NULL DEFAULT false;

-- Reasonable check on primary_persona values (kept open enough not to break)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_primary_persona_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_primary_persona_check
      CHECK (primary_persona IS NULL OR primary_persona IN (
        'tenant','landlord','funder','agent','partner','staff','other'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_address_complete
  ON public.profiles (address_complete) WHERE address_complete = false;
CREATE INDEX IF NOT EXISTS idx_profiles_primary_persona
  ON public.profiles (primary_persona) WHERE primary_persona IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_continent
  ON public.profiles (continent) WHERE continent IS NOT NULL;

-- 2. Recompute address_complete automatically.
--    Rule: country + primary_persona required. For Uganda we also require district.
CREATE OR REPLACE FUNCTION public.recompute_profile_address_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_complete boolean;
BEGIN
  v_complete :=
    NEW.country IS NOT NULL AND length(btrim(NEW.country)) > 0
    AND NEW.primary_persona IS NOT NULL
    AND (
      lower(NEW.country) <> 'uganda'
      OR (NEW.district IS NOT NULL AND length(btrim(NEW.district)) > 0)
    );

  NEW.address_complete := v_complete;
  IF v_complete AND NEW.address_completed_at IS NULL THEN
    NEW.address_completed_at := now();
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_recompute_profile_address_complete ON public.profiles;
CREATE TRIGGER trg_recompute_profile_address_complete
  BEFORE INSERT OR UPDATE OF country, continent, district, town, sub_county, parish, village, primary_persona
  ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_profile_address_complete();

-- 3. Profile completion audit log
CREATE TABLE IF NOT EXISTS public.profile_completion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action text NOT NULL,             -- 'address_set' | 'persona_set' | 'referrer_override'
  previous_value jsonb,
  new_value jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profile_completion_log_user
  ON public.profile_completion_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_completion_log_action
  ON public.profile_completion_log (action, created_at DESC);

ALTER TABLE public.profile_completion_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can insert their own completion log"
  ON public.profile_completion_log;
CREATE POLICY "Users can insert their own completion log"
  ON public.profile_completion_log
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view their own completion log"
  ON public.profile_completion_log;
CREATE POLICY "Users can view their own completion log"
  ON public.profile_completion_log
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Leadership can view all completion logs"
  ON public.profile_completion_log;
CREATE POLICY "Leadership can view all completion logs"
  ON public.profile_completion_log
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
  );

-- 4. Backfill address_complete for existing rows so we don't prompt
--    users who already have rich profiles. (Trigger only fires on writes.)
UPDATE public.profiles
SET address_complete = true,
    address_completed_at = COALESCE(address_completed_at, updated_at, now())
WHERE address_complete = false
  AND country IS NOT NULL AND length(btrim(country)) > 0
  AND district IS NOT NULL AND length(btrim(district)) > 0;