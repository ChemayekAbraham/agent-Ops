-- One account per device per 24 hours, enforced where it cannot be bypassed
--
-- WHAT ALREADY EXISTED, AND WHY IT WAS NOT ENOUGH
--
-- `record_signup_attempt` already refuses a second signup from the same
-- device_fp inside 24 hours. But it is CLIENT-CALLED — `src/lib/signupGuard.ts`
-- invokes it before signing up. Nothing forces that call. Anyone posting
-- straight at the Auth REST endpoint never runs it.
--
-- handle_new_user's own comment says exactly this about the referral velocity
-- cap it added on 2026-09-14:
--
--     "This fires as a trigger on auth.users itself, so it cannot be bypassed
--      by calling the Auth REST endpoint directly the way the client-side
--      signupGuard.ts check can be."
--
-- The device rule was left in the bypassable layer. Given the ring that put
-- 34,317 accounts through in five days (10-14 September, all now frozen), that
-- is the half worth closing.
--
-- HOW THIS CLOSES IT
--
-- The fingerprint is recorded ON THE PROFILE at creation, and the 24-hour count
-- is taken from real accounts rather than from the advisory attempt log. A
-- signup that never called the guard still leaves a row that the next one is
-- counted against.
--
-- WHAT IS EXCLUDED, AND HOW
--
-- Tenant registration — an agent posting a rent request for someone — must not
-- be caught by this. One agent registers many tenants from one phone, all day,
-- legitimately. Those paths (`register-tenant`, `submit-tenant-form`) already
-- have their own, looser caps in `record_agent_assisted_signup`: 5 per hour and
-- 15 per day per device.
--
-- They are excluded by an explicit positive marker, `signup_channel =
-- 'agent_assisted'`, set by those two edge functions — NOT by the absence of a
-- fingerprint. Excluding on absence would mean anyone who simply omits the
-- field walks through, which is the hole this migration exists to close.
--
-- The same marker covers the other service-role paths that create users without
-- a browser: activate-supporter, import-partners, create-supporter-invite,
-- create-funder-onboarding-account, create-share-onboarding.

-- ---------------------------------------------------------------------------
-- 1. Record the device on the account itself
--
-- signup_attempts is written by the client and can be skipped. profiles cannot:
-- the row is created by the trigger, in the same transaction as the auth user.
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS signup_device_fp text,
  ADD COLUMN IF NOT EXISTS signup_channel   text;

COMMENT ON COLUMN public.profiles.signup_device_fp IS
  'Device fingerprint captured at signup, from raw_user_meta_data.device_fp. '
  'The one-account-per-device-per-day rule counts these, not signup_attempts, '
  'because signup_attempts is client-written and can be skipped entirely.';

COMMENT ON COLUMN public.profiles.signup_channel IS
  'How the account was created. ''agent_assisted'' marks tenant registration '
  'and other service-role paths, which are exempt from the device rule and '
  'capped separately by record_agent_assisted_signup.';

-- Partial index: the rule only ever looks at the last 24 hours, and only at
-- rows that carry a fingerprint. Indexing the whole 96k-row table would be
-- mostly nulls.
CREATE INDEX IF NOT EXISTS idx_profiles_signup_device_recent
  ON public.profiles (signup_device_fp, created_at DESC)
  WHERE signup_device_fp IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The gate, inside handle_new_user
--
-- Anchored patch against the live definition. The function is 200+ lines of
-- signup logic — fraud blocklists, phone uniqueness, role assignment, campaign
-- attribution — and retyping it is how that gets broken. Each replace() is
-- asserted, so drift fails loudly rather than silently skipping a change.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE src text; before text;
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'handle_new_user';

  IF src IS NULL THEN RAISE EXCEPTION 'handle_new_user not found'; END IF;

  IF position('signup_device_blocked' in src) > 0 THEN
    RAISE NOTICE 'handle_new_user already carries the device gate, skipping';
    RETURN;
  END IF;

  -- (a) declarations
  before := src;
  src := replace(src,
    '  v_recent_day_count int := 0;',
    '  v_recent_day_count int := 0;'||chr(10)||
    '  v_device_fp text;'||chr(10)||
    '  v_signup_channel text;'||chr(10)||
    '  v_device_count int := 0;');
  IF src = before THEN RAISE EXCEPTION 'anchor (a) v_recent_day_count declaration missing'; END IF;

  -- (b) the gate itself, immediately after the referral velocity guard and
  --     before role assignment, so a blocked device never reaches the insert.
  before := src;
  src := replace(src,
'  v_intended_role := NULLIF(NEW.raw_user_meta_data->>''intended_role'', '''');',
'  -- ===== One account per device per 24 hours =====
  -- Counted from profiles, not signup_attempts: the attempt log is written by
  -- the client and a direct Auth REST call never touches it.
  v_device_fp := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>''device_fp'', '''')), '''');
  v_signup_channel := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>''signup_channel'', '''')), '''');

  -- Same shape test the client-side guard uses, so a junk value cannot be sent
  -- to dodge the count by never matching a previous one.
  IF v_device_fp IS NOT NULL
     AND NOT (v_device_fp ~ ''^[a-f0-9]{64}$'' OR v_device_fp ~ ''^fb_[a-f0-9]{1,64}$'') THEN
    v_device_fp := NULL;
  END IF;

  IF v_device_fp IS NOT NULL AND v_signup_channel IS DISTINCT FROM ''agent_assisted'' THEN
    SELECT count(*) INTO v_device_count
    FROM public.profiles p
    WHERE p.signup_device_fp = v_device_fp
      AND COALESCE(p.signup_channel, '''') <> ''agent_assisted''
      AND p.created_at > now() - interval ''24 hours'';

    IF v_device_count >= 1 THEN
      RAISE EXCEPTION ''signup_device_blocked: an account was already created on this device in the last 24 hours; please try again tomorrow or contact support''
        USING ERRCODE = ''28000'';
    END IF;
  END IF;

  v_intended_role := NULLIF(NEW.raw_user_meta_data->>''intended_role'', '''');');
  IF src = before THEN RAISE EXCEPTION 'anchor (b) intended_role assignment missing'; END IF;

  -- (c) persist the fingerprint and channel on the profile
  before := src;
  src := replace(src,
'  INSERT INTO public.profiles (id, email, full_name, phone, referrer_id, signup_source, funder_reference)',
'  INSERT INTO public.profiles (id, email, full_name, phone, referrer_id, signup_source, funder_reference, signup_device_fp, signup_channel)');
  IF src = before THEN RAISE EXCEPTION 'anchor (c) profiles insert column list missing'; END IF;

  before := src;
  src := replace(src,
'    v_signup_source,
    v_funder_ref
  )
  ON CONFLICT (id) DO UPDATE SET',
'    v_signup_source,
    v_funder_ref,
    v_device_fp,
    v_signup_channel
  )
  ON CONFLICT (id) DO UPDATE SET');
  IF src = before THEN RAISE EXCEPTION 'anchor (d) profiles insert values missing'; END IF;

  -- (e) keep them on the upsert path too, without overwriting a recorded value
  before := src;
  src := replace(src,
'    funder_reference = COALESCE(profiles.funder_reference, EXCLUDED.funder_reference),',
'    funder_reference = COALESCE(profiles.funder_reference, EXCLUDED.funder_reference),
    signup_device_fp = COALESCE(profiles.signup_device_fp, EXCLUDED.signup_device_fp),
    signup_channel   = COALESCE(profiles.signup_channel, EXCLUDED.signup_channel),');
  IF src = before THEN RAISE EXCEPTION 'anchor (e) funder_reference upsert line missing'; END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.handle_new_user()
     RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L', src);
END
$do$;

-- ---------------------------------------------------------------------------
-- 3. A device-centric view for the CTO console
--
-- The existing panel lists attempts in time order, which answers "what happened
-- just now". It does not answer "which devices are farming accounts", which is
-- the question during a ring. This groups by fingerprint and ranks by how many
-- accounts actually got created.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_signup_device_abuse(
  p_days  integer DEFAULT 7,
  p_limit integer DEFAULT 100)
RETURNS TABLE (
  device_fp          text,
  accounts_created   bigint,
  attempts_total     bigint,
  attempts_blocked   bigint,
  distinct_ips       bigint,
  distinct_referrers bigint,
  agent_assisted     boolean,
  first_seen         timestamptz,
  last_seen          timestamptz,
  sample_user_agent  text,
  account_names      text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH win AS (
    SELECT (now() - make_interval(days => GREATEST(1, LEAST(90, COALESCE(p_days, 7))))) AS since
  ),
  att AS (
    SELECT s.device_fp,
           count(*)                                   AS attempts_total,
           count(*) FILTER (WHERE s.status <> 'allowed') AS attempts_blocked,
           count(DISTINCT s.ip)                       AS distinct_ips,
           bool_or(s.utm_medium = 'agent_assisted')    AS agent_assisted,
           min(s.created_at)                          AS first_seen,
           max(s.created_at)                          AS last_seen,
           (array_agg(s.user_agent ORDER BY s.created_at DESC)
              FILTER (WHERE s.user_agent IS NOT NULL))[1] AS sample_user_agent
    FROM public.signup_attempts s, win
    WHERE s.device_fp IS NOT NULL AND s.created_at >= win.since
    GROUP BY s.device_fp
  ),
  acc AS (
    SELECT p.signup_device_fp AS device_fp,
           count(*)                                AS accounts_created,
           count(DISTINCT p.referrer_id)           AS distinct_referrers,
           min(p.created_at)                       AS first_seen,
           max(p.created_at)                       AS last_seen,
           string_agg(DISTINCT left(p.full_name, 28), ' · '
                      ORDER BY left(p.full_name, 28)) AS account_names
    FROM public.profiles p, win
    WHERE p.signup_device_fp IS NOT NULL AND p.created_at >= win.since
    GROUP BY p.signup_device_fp
  )
  SELECT COALESCE(acc.device_fp, att.device_fp)                       AS device_fp,
         COALESCE(acc.accounts_created, 0)                            AS accounts_created,
         COALESCE(att.attempts_total, 0)                              AS attempts_total,
         COALESCE(att.attempts_blocked, 0)                            AS attempts_blocked,
         COALESCE(att.distinct_ips, 0)                                AS distinct_ips,
         COALESCE(acc.distinct_referrers, 0)                          AS distinct_referrers,
         COALESCE(att.agent_assisted, false)                          AS agent_assisted,
         LEAST(COALESCE(acc.first_seen, att.first_seen), COALESCE(att.first_seen, acc.first_seen)) AS first_seen,
         GREATEST(COALESCE(acc.last_seen, att.last_seen), COALESCE(att.last_seen, acc.last_seen)) AS last_seen,
         att.sample_user_agent,
         acc.account_names
  FROM acc FULL OUTER JOIN att ON att.device_fp = acc.device_fp
  ORDER BY COALESCE(acc.accounts_created, 0) DESC,
           COALESCE(att.attempts_total, 0) DESC
  LIMIT GREATEST(1, LEAST(500, COALESCE(p_limit, 100)));
$function$;

REVOKE ALL ON FUNCTION public.get_signup_device_abuse(integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_signup_device_abuse(integer, integer) TO authenticated;

COMMENT ON FUNCTION public.get_signup_device_abuse(integer, integer) IS
  'Devices ranked by accounts actually created, for the CTO signup console. '
  'Joins the advisory attempt log to the accounts that really exist, so a '
  'device that bypassed the client guard still appears. agent_assisted marks '
  'tenant registration, which is exempt from the one-per-day rule.';
