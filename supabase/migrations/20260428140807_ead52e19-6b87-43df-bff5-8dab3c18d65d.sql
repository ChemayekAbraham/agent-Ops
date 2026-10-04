
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS signup_source text;

CREATE INDEX IF NOT EXISTS idx_profiles_signup_source ON public.profiles(signup_source);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_referrer_id  uuid;
  v_intended_role text;
  v_signup_source text;
  v_referrer_is_agent boolean := FALSE;
BEGIN
  v_referrer_id := NULLIF(NEW.raw_user_meta_data->>'referrer_id', '')::uuid;
  v_intended_role := NULLIF(NEW.raw_user_meta_data->>'intended_role', '');
  v_signup_source := NULLIF(NEW.raw_user_meta_data->>'signup_source', '');

  INSERT INTO public.profiles (id, email, full_name, phone, referrer_id, signup_source)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    v_referrer_id,
    v_signup_source
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), profiles.full_name),
    phone = COALESCE(NULLIF(EXCLUDED.phone, ''), profiles.phone),
    referrer_id = COALESCE(EXCLUDED.referrer_id, profiles.referrer_id),
    signup_source = COALESCE(profiles.signup_source, EXCLUDED.signup_source),
    updated_at = now();

  IF v_intended_role = 'agent' AND v_referrer_id IS NOT NULL AND v_referrer_id <> NEW.id THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_referrer_id AND role = 'agent'
    ) INTO v_referrer_is_agent;

    IF v_referrer_is_agent THEN
      INSERT INTO public.agent_subagents (parent_agent_id, sub_agent_id, source, status)
      VALUES (v_referrer_id, NEW.id, 'link_signup', 'verified')
      ON CONFLICT (sub_agent_id) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'handle_new_user failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

-- Backfill: existing supporters without an agent-led proxy registration are self-signups.
UPDATE public.profiles p
SET signup_source = 'funder-onboarding'
WHERE p.signup_source IS NULL
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p.id AND ur.role = 'supporter' AND ur.enabled = true
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.proxy_agent_assignments paa
    WHERE paa.beneficiary_id = p.id AND paa.beneficiary_role = 'supporter'
  );
