-- Throwaway stand-ins for the production objects the Phase 1 migration
-- (20261105150000_partner_return_policy_phase1.sql) touches. LOCAL TEST CLUSTER ONLY:
-- this drops and recreates the public, auth and cron schemas.
--
--   psql -h localhost -p 55432 -U postgres -d postgres -X -v ON_ERROR_STOP=1 -1 -f race_stub.sql
--
-- Shapes follow production as verified 2026-11-06 (column names, NOT NULL, trigger names on
-- promissory_notes, RLS write paths for authenticated). Everything not used by Phase 1 is omitted.

DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
DROP SCHEMA IF EXISTS auth CASCADE;   CREATE SCHEMA auth;
DROP SCHEMA IF EXISTS cron CASCADE;   CREATE SCHEMA cron;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth (Supabase shapes: claim.sub / claim.role, or the request.jwt.claims JSON)
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''),
                  NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''),
                  NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
                  jsonb_strip_nulls(jsonb_build_object('sub', NULLIF(current_setting('request.jwt.claim.sub', true), ''),
                                                       'role', NULLIF(current_setting('request.jwt.claim.role', true), '')))) $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

-- Deterministic test identities: pid('ceo'), pid('ex20') ... (md5 of the name, as a uuid).
CREATE FUNCTION public.pid(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('person:' || p_name)::uuid $$;

-- ---------------------------------------------------------------------------
-- Roles and staff helpers
-- ---------------------------------------------------------------------------
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL, enabled boolean NOT NULL DEFAULT true,
                                PRIMARY KEY (user_id, role));
-- Round 4: production policies on promissory_note_pledge_notices read user_roles directly ("Ops view pledge notices"), so a
-- browser needs SELECT on it. Assumed (user_roles' own policies were not read): a signed-in user reads their own role rows.
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY t_own_roles ON public.user_roles FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
GRANT SELECT ON public.user_roles TO authenticated;
CREATE FUNCTION public._has_enabled_role(p_user uuid, p_roles text[]) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_user AND enabled AND role = ANY (p_roles)) $$;
CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT public._has_enabled_role(_user_id, ARRAY[_role]) $$;
CREATE FUNCTION public.staff_mfa_ok() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION public.require_staff_aal2() RETURNS void LANGUAGE sql AS $$ SELECT $$;

CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);
CREATE TABLE public.audit_logs (id bigserial PRIMARY KEY, user_id uuid, action_type text, table_name text, record_id text,
  old_values jsonb, new_values jsonb, reason text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.system_events (id bigserial PRIMARY KEY, event_type text NOT NULL, user_id uuid, metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.money_path_drift_events (id bigserial PRIMARY KEY, detected_at timestamptz NOT NULL DEFAULT now(),
  check_name text NOT NULL, detail text, resolved_at timestamptz);

-- Email: production enqueue_email = pgmq.send into the Mailgun queue. Here it records the payload.
CREATE TABLE public._email_outbox (id bigserial PRIMARY KEY, queue_name text NOT NULL, payload jsonb NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION public.enqueue_email(queue_name text, payload jsonb) RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS
  $$ INSERT INTO public._email_outbox (queue_name, payload) VALUES ($1, $2) RETURNING id $$;

-- pg_cron stand-in (3-argument schedule upserts by name, as pg_cron does).
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text NOT NULL, command text NOT NULL,
  active boolean NOT NULL DEFAULT true);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES ($1, $2, $3)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command, active = true
  RETURNING jobid $$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $$
  WITH d AS (DELETE FROM cron.job WHERE jobname = $1 RETURNING 1) SELECT EXISTS (SELECT 1 FROM d) $$;

-- ---------------------------------------------------------------------------
-- Portfolios and the money paths Phase 1 reads/writes
-- ---------------------------------------------------------------------------
CREATE TABLE public.investor_portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id uuid,
  agent_id uuid,
  portfolio_code text,
  investment_amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  roi_percentage numeric NOT NULL DEFAULT 15,
  roi_mode text DEFAULT 'monthly_payout',
  locked_from_portfolio_id uuid,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX investor_portfolios_investor_status ON public.investor_portfolios (investor_id, status);
-- Renewals (production: apply_portfolio_renewal inserts one row per renewal and moves created_at).
CREATE TABLE public.portfolio_renewals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), portfolio_id uuid NOT NULL,
  old_roi_percentage numeric, new_roi_percentage numeric, created_at timestamptz NOT NULL DEFAULT now());
-- Authenticated users insert through RLS (agent_id = auth.uid()); staff update.
ALTER TABLE public.investor_portfolios ENABLE ROW LEVEL SECURITY;
CREATE POLICY ip_agent_insert ON public.investor_portfolios FOR INSERT TO authenticated
  WITH CHECK (agent_id = (SELECT auth.uid()));
CREATE POLICY ip_read ON public.investor_portfolios FOR SELECT TO authenticated
  USING (agent_id = (SELECT auth.uid()) OR investor_id = (SELECT auth.uid())
         OR (SELECT public._has_enabled_role((SELECT auth.uid()), ARRAY['ceo','cfo','coo','super_admin','manager'])));
CREATE POLICY ip_staff_update ON public.investor_portfolios FOR UPDATE TO authenticated
  USING ((SELECT public._has_enabled_role((SELECT auth.uid()), ARRAY['ceo','cfo','coo','super_admin','manager'])));
GRANT SELECT, INSERT, UPDATE ON public.investor_portfolios TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.investor_portfolios TO service_role;

CREATE TABLE public.pending_wallet_operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid,
  source_table text, category text, status text, reviewed_at timestamptz);
CREATE FUNCTION public.is_portfolio_on_hold(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

-- A renewal keeps the stored rate (mirrors 20261016140000: the UPDATE never sets roi_percentage).
CREATE FUNCTION public.apply_portfolio_renewal(p_portfolio_id uuid, p_renewed_by uuid,
  p_reason text DEFAULT 'Auto-renewal at maturity', p_source text DEFAULT 'manual', p_is_auto boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rate numeric;
BEGIN
  UPDATE public.investor_portfolios SET
    created_at = now(),
    status = 'active'
  WHERE id = p_portfolio_id
  RETURNING roi_percentage INTO v_rate;
  RETURN jsonb_build_object('portfolio_id', p_portfolio_id, 'roi_percentage', v_rate);
END $$;

CREATE TABLE public.hr_staff (user_id uuid UNIQUE NOT NULL, active boolean NOT NULL DEFAULT true, ended_on date);

CREATE TABLE public.promissory_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number text NOT NULL DEFAULT '0700000000',
  phone_number text,
  email text,
  agent_id uuid,
  partner_user_id uuid,
  amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  fulfilment_due_on date,
  recorded_on date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX promissory_notes_partner ON public.promissory_notes (partner_user_id);
CREATE FUNCTION public.link_promissory_note_partner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER trg_link_promissory_note_partner BEFORE INSERT ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.link_promissory_note_partner();
CREATE FUNCTION public.validate_promissory_note() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_validate_promissory_note BEFORE INSERT OR UPDATE ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.validate_promissory_note();
-- Production's RLS on promissory_notes (pg_policies read 2026-11-06, round 4), same names and expressions; app_role
-- values are text here. Browsers READ a note only as an admin role or as the partner it is linked to: an agent has no
-- read policy, so an agent's UPDATE ... WHERE (which needs read access) reaches none of its notes either.
CREATE FUNCTION public.current_user_has_any_role_ignoring_enabled(p_roles text[]) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = ANY (p_roles)) $$;
ALTER TABLE public.promissory_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin roles can delete promissory notes" ON public.promissory_notes FOR DELETE TO authenticated
  USING ((SELECT public.current_user_has_any_role_ignoring_enabled(ARRAY['operations','cfo','coo','super_admin','manager','ceo'])));
CREATE POLICY "Admin roles can update promissory notes" ON public.promissory_notes FOR UPDATE TO authenticated
  USING ((SELECT public.current_user_has_any_role_ignoring_enabled(ARRAY['operations','cfo','coo','super_admin','manager','partner_ops','agent_ops'])));
CREATE POLICY "Admin roles can view all promissory notes" ON public.promissory_notes FOR SELECT TO authenticated
  USING ((SELECT public.current_user_has_any_role_ignoring_enabled(ARRAY['operations','cfo','coo','super_admin','manager','partner_ops','agent_ops'])));
CREATE POLICY "Agents can create promissory notes" ON public.promissory_notes FOR INSERT TO authenticated
  WITH CHECK (agent_id = (SELECT auth.uid()));
CREATE POLICY "Agents can update own pending notes" ON public.promissory_notes FOR UPDATE TO authenticated
  USING (agent_id = (SELECT auth.uid()) AND status = 'pending');
CREATE POLICY "Partners can view own linked notes" ON public.promissory_notes FOR SELECT TO authenticated
  USING (partner_user_id = (SELECT auth.uid()));
CREATE POLICY mfa_required_for_staff ON public.promissory_notes AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
GRANT SELECT, INSERT, UPDATE ON public.promissory_notes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promissory_notes TO service_role;

CREATE TABLE public.partner_agreements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_id uuid UNIQUE NOT NULL,
  partner_signature_data_url text, countersigned_at timestamptz, status text);
-- Click-through acceptance (not referenced by Phase 1; present to prove it is ignored).
CREATE TABLE public.supporter_agreement_acceptance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  accepted_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.funder_pending_portfolios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), portfolio_id uuid, commitment_id uuid);
CREATE TABLE public.partner_self_commitments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_id uuid,
  monthly_rate numeric NOT NULL DEFAULT 15);
CREATE TABLE public.partner_self_funding_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), commitment_id uuid,
  monthly_rate numeric NOT NULL DEFAULT 15, status text NOT NULL DEFAULT 'active', completed_at timestamptz);
CREATE TABLE public.partner_supported_houses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), portfolio_id uuid, commitment_id uuid,
  monthly_rate numeric NOT NULL DEFAULT 15, cancelled_at timestamptz);
CREATE TABLE public.partner_self_payout_cycles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), commitment_id uuid, paid_at timestamptz);
-- Production has AFTER INSERT OR UPDATE trg_funder_house_progress_notices here; the stand-in counts firings.
CREATE TABLE public._house_notice_log (id bigserial PRIMARY KEY, house_id uuid, op text, old_rate numeric, new_rate numeric,
  at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION public.funder_house_progress_notices() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public._house_notice_log (house_id, op, old_rate, new_rate)
  VALUES (NEW.id, TG_OP, CASE WHEN TG_OP = 'UPDATE' THEN OLD.monthly_rate END, NEW.monthly_rate);
  RETURN NULL;
END $$;
CREATE TRIGGER trg_funder_house_progress_notices AFTER INSERT OR UPDATE ON public.partner_supported_houses
  FOR EACH ROW EXECUTE FUNCTION public.funder_house_progress_notices();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role, authenticated;

-- ---------------------------------------------------------------------------
-- Staff identities
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  (public.pid('ceo'), 'ceo@welile.test'), (public.pid('cfo'), 'cfo@welile.test'),
  (public.pid('superadmin'), 'superadmin@welile.test'), (public.pid('coo'), 'coo@welile.test'),
  (public.pid('ceo_disabled'), 'old-ceo@welile.test'), (public.pid('agent1'), 'agent1@welile.test'),
  (public.pid('agent2'), 'agent2@welile.test');
INSERT INTO public.user_roles (user_id, role, enabled) VALUES
  (public.pid('ceo'), 'ceo', true), (public.pid('cfo'), 'cfo', true), (public.pid('superadmin'), 'super_admin', true),
  (public.pid('coo'), 'coo', true), (public.pid('ceo_disabled'), 'ceo', false),
  (public.pid('agent1'), 'agent', true), (public.pid('agent2'), 'agent', true);
INSERT INTO public.profiles (id, full_name) SELECT id, split_part(email, '@', 1) FROM auth.users;

-- ---------------------------------------------------------------------------
-- Pre-migration data (exists BEFORE Phase 1 is applied)
-- ---------------------------------------------------------------------------
-- Two legacy portfolios (no decision stamps): one took the old column default, one typed 20.
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount)
VALUES (public.pid('legacy15'), public.pid('agent1'), 'LEG-15', 500000);
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, roi_percentage)
VALUES (public.pid('legacy20'), public.pid('agent1'), 'LEG-20', 500000, 20);

-- Promissory notes written long before the cut-off. Dates are relative to the run date so the
-- note window (GREATEST(due, cut-off) + 30 days) is open at a fresh cut-off and closed once the
-- cut-off is backdated by 60 days.
INSERT INTO public.promissory_notes (agent_id, partner_user_id, amount, status, fulfilment_due_on, recorded_on) VALUES
  (public.pid('agent1'), public.pid('note1'),     1000000, 'activated', current_date - 200, current_date - 240),
  (public.pid('agent1'), public.pid('note2'),     1000000, 'activated', current_date - 200, current_date - 240),
  (public.pid('agent1'), NULL,                    500000,  'pending',   current_date - 100, current_date - 120),
  (public.pid('agent1'), public.pid('notemove'),  500000,  'pending',   current_date - 100, current_date - 120);
-- Back-date updated_at past the validate trigger so "unchanged" is meaningful.
ALTER TABLE public.promissory_notes DISABLE TRIGGER trg_validate_promissory_note;
UPDATE public.promissory_notes SET updated_at = timestamptz '2026-03-01 10:00+03', created_at = timestamptz '2026-03-01 10:00+03';
ALTER TABLE public.promissory_notes ENABLE TRIGGER trg_validate_promissory_note;

-- What the notes look like before the migration (no row may be rewritten by it).
CREATE TABLE public._t_note_before AS
  SELECT id, updated_at, xmin::text AS xmin_before, ctid::text AS ctid_before FROM public.promissory_notes;

CREATE OR REPLACE FUNCTION public.normalize_phone_last9(phone text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE digits text;
BEGIN
  IF phone IS NULL THEN RETURN NULL; END IF;
  digits := regexp_replace(phone, '\D', '', 'g');
  IF length(digits) >= 9 THEN RETURN right(digits, 9); END IF;
  RETURN NULL;
END $$;
