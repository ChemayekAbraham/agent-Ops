-- Funder Attribution + Unique Funder Reference (re-applying the 2026-04-29 migration that never ran)

-- 1) Backfill the two known self-registered Funders
UPDATE public.profiles
SET signup_source = 'funder-onboarding', updated_at = now()
WHERE email IN ('techworldinfo94@gmail.com','nakimuliprossy85@gmail.com')
  AND (signup_source IS NULL OR signup_source = '');

-- 2) Add nullable funder_reference column
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS funder_reference TEXT;

-- Unique only on non-null values
CREATE UNIQUE INDEX IF NOT EXISTS profiles_funder_reference_unique_idx
  ON public.profiles (funder_reference)
  WHERE funder_reference IS NOT NULL;

-- 3) Deterministic builder: WLF-YYYY-XXXXXX
CREATE OR REPLACE FUNCTION public.build_funder_reference(p_user_id uuid, p_created_at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT 'WLF-'
       || EXTRACT(YEAR FROM COALESCE(p_created_at, now()))::text
       || '-'
       || UPPER(RPAD(SUBSTRING(REGEXP_REPLACE(p_user_id::text, '[^a-zA-Z0-9]', '', 'g'), 1, 6), 6, 'X'));
$$;

-- 4) Update handle_new_user to auto-stamp funder_reference for /funder-onboarding signups
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
  v_funder_ref text;
  v_referrer_is_agent boolean := FALSE;
BEGIN
  v_referrer_id := NULLIF(NEW.raw_user_meta_data->>'referrer_id', '')::uuid;
  v_intended_role := NULLIF(NEW.raw_user_meta_data->>'intended_role', '');
  v_signup_source := NULLIF(NEW.raw_user_meta_data->>'signup_source', '');

  IF v_signup_source = 'funder-onboarding' THEN
    v_funder_ref := public.build_funder_reference(NEW.id, NEW.created_at);
  ELSE
    v_funder_ref := NULL;
  END IF;

  INSERT INTO public.profiles (id, email, full_name, phone, referrer_id, signup_source, funder_reference)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    v_referrer_id,
    v_signup_source,
    v_funder_ref
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), profiles.full_name),
    phone = COALESCE(NULLIF(EXCLUDED.phone, ''), profiles.phone),
    referrer_id = COALESCE(EXCLUDED.referrer_id, profiles.referrer_id),
    signup_source = COALESCE(profiles.signup_source, EXCLUDED.signup_source),
    funder_reference = COALESCE(profiles.funder_reference, EXCLUDED.funder_reference),
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

-- 5) Backfill funder_reference for all existing funder-onboarding profiles
UPDATE public.profiles
SET funder_reference = public.build_funder_reference(id, created_at),
    updated_at = now()
WHERE signup_source = 'funder-onboarding'
  AND funder_reference IS NULL;