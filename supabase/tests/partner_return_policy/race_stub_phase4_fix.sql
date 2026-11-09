-- Stand-ins the Phase 4 fixes (S1 contact proof, S7 trust masks) need. LOCAL TEST CLUSTER ONLY.
-- Load after race_stub.sql + race_stub_phase2.sql + race_stub_phase4.sql and BEFORE Phase 1 (4a's
-- _note_contact_proven is LANGUAGE sql, so the tables it reads must exist when 4a is applied). Then load
-- prod_link_functions.sql and prod_trust_impl.sql (verbatim production text, md5-checked) in place of the stubs'
-- simplified versions. Column shapes follow production (information_schema, read 2026-11-07).
SET client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- S1: the records that prove a person completed a code or link sent to a contact.
-- ---------------------------------------------------------------------------
-- otp-login: an SMS code to `phone` was verified and the login resolved to resolved_user_id (outcome 'success').
CREATE TABLE IF NOT EXISTS public.otp_login_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text, resolved_user_id uuid, outcome text NOT NULL, reason text,
  stage text, expected_user_id uuid, actual_user_id uuid, origin text, ip_address text, user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_otp_login_audit_resolved_user ON public.otp_login_audit (resolved_user_id);
-- self-update-phone: status 'consumed' only after the new number's SMS code (otp_verifications) and the emailed
-- approval code were both verified for this user and this new_phone_last9. Other statuses: pending, expired, failed.
CREATE TABLE IF NOT EXISTS public.phone_change_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, old_phone text NOT NULL DEFAULT '',
  new_phone_last9 text NOT NULL, otp_hash text NOT NULL DEFAULT 'x', otp_expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, status text NOT NULL DEFAULT 'pending',
  consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_phone_change_otp_challenges_user ON public.phone_change_otp_challenges (user_id, created_at DESC);
-- email-verify-confirm (confirm_email_verification): verified_at is set when the emailed code was entered.
CREATE TABLE IF NOT EXISTS public.email_verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, new_email text NOT NULL, old_email text NOT NULL DEFAULT '',
  code_hash text NOT NULL DEFAULT 'x', attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5,
  send_count integer NOT NULL DEFAULT 1, last_sent_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes', verified_at timestamptz, consumed_at timestamptz,
  failure_reason text, ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_evc_user_created ON public.email_verification_challenges (user_id, created_at DESC);
-- Supabase auth identities (google / apple sign-in carry the provider-verified email in identity_data).
CREATE TABLE IF NOT EXISTS auth.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id text NOT NULL, user_id uuid NOT NULL, identity_data jsonb NOT NULL,
  provider text NOT NULL, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
  email text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED);
CREATE INDEX IF NOT EXISTS identities_user_id_idx ON auth.identities (user_id);
-- Production: no browser write path on any of these (RLS: no INSERT/UPDATE policy for anon/authenticated).
REVOKE ALL ON public.otp_login_audit, public.phone_change_otp_challenges, public.email_verification_challenges FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.otp_login_audit, public.phone_change_otp_challenges,
  public.email_verification_challenges TO service_role;

-- ---------------------------------------------------------------------------
-- S7: what production's _get_user_trust_profile_impl reads without an exception handler.
-- (wallets, agent_subagents, staff_permissions, angel_pool_investments are read inside BEGIN ... EXCEPTION blocks;
-- the stand-ins below let the tests drive them anyway.)
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS verified boolean DEFAULT false, ADD COLUMN IF NOT EXISTS national_id text,
  ADD COLUMN IF NOT EXISTS avatar_url text, ADD COLUMN IF NOT EXISTS always_share_location boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_continuous_location_at timestamptz, ADD COLUMN IF NOT EXISTS referrer_id uuid;
ALTER TABLE public.rent_requests ADD COLUMN IF NOT EXISTS amount_repaid numeric DEFAULT 0;
ALTER TABLE public.landlords ADD COLUMN IF NOT EXISTS registered_by uuid, ADD COLUMN IF NOT EXISTS verified boolean DEFAULT false;
CREATE TABLE IF NOT EXISTS public.user_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, captured_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.venue_visits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, category text,
  paid_with_wallet boolean DEFAULT false, visited_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.wallets (user_id uuid PRIMARY KEY, balance numeric NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.agent_subagents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_agent_id uuid, status text);
CREATE TABLE IF NOT EXISTS public.staff_permissions (user_id uuid, is_active boolean DEFAULT true);
CREATE TABLE IF NOT EXISTS public.angel_pool_investments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), investor_id uuid,
  amount numeric NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'active');
DO $f$ BEGIN
  IF to_regprocedure('public.compute_agent_performance(uuid)') IS NULL THEN
    CREATE FUNCTION public.compute_agent_performance(p_agent uuid)
     RETURNS TABLE (qualifying_tenants integer, healthy_tenants integer, healthy_ratio numeric, collection_rate numeric, monthly_book numeric)
     LANGUAGE sql STABLE AS $b$ SELECT 0, 0, 0::numeric, 0::numeric, 0::numeric $b$;
  END IF;
END $f$;
-- R4 (p4r4sql): production has RLS ON for system_events (checked 2026-11-07) and activation_contact_match now requires it.
ALTER TABLE public.system_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS r4_stub_events_insert ON public.system_events;
CREATE POLICY r4_stub_events_insert ON public.system_events FOR INSERT TO authenticated WITH CHECK (user_id IS NULL OR user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS r4_stub_events_read ON public.system_events;
CREATE POLICY r4_stub_events_read ON public.system_events FOR SELECT TO authenticated USING (true);
-- production's service_role bypasses RLS; the stub's does not.
DROP POLICY IF EXISTS r4_stub_events_service ON public.system_events;
CREATE POLICY r4_stub_events_service ON public.system_events FOR ALL TO service_role USING (true) WITH CHECK (true);
SELECT 'stub phase4 fix ready';
