-- Extra throwaway stand-ins for the production objects the Phase 2 migration
-- (20261108161000_partner_return_policy_phase2.sql) touches. LOCAL TEST CLUSTER ONLY.
-- Load AFTER race_stub.sql and BEFORE the Phase 1 migration:
--
--   psql -h localhost -p 55432 -U postgres -d postgres -X -v ON_ERROR_STOP=1 -1 -f race_stub.sql
--   psql -h localhost -p 55432 -U postgres -d postgres -X -v ON_ERROR_STOP=1 -1 -f race_stub_phase2.sql
--
-- Column names, types, NOT NULLs, unique indexes and function signatures/ACLs follow production
-- (byrzshwlentqvktcksem, information_schema / pg_indexes / pg_proc read 2026-11-06). Bodies of
-- helper functions are copied from production where they decide anything the tests look at
-- (house_has_live_claim, is_ops_role, _partner_contract_coverage, link_promissory_note_partner,
-- link_promissory_notes_for_user, partner_self_topup_eligibility, normalize_phone_last9);
-- everything else is a minimal stand-in. The functions Phase 2 replaces exist here first with
-- their production signature and ACL (placeholder bodies), so CREATE OR REPLACE / DROP behave
-- as they will in production.

DROP SCHEMA IF EXISTS net CASCADE;        CREATE SCHEMA net;
DROP SCHEMA IF EXISTS extensions CASCADE; CREATE SCHEMA extensions;
GRANT USAGE ON SCHEMA net, extensions TO anon, authenticated, service_role;
DO $$ BEGIN
  -- PostgREST's login role (session_user in production; never postgres).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END $$;
GRANT anon, authenticated, service_role TO authenticator;

-- pg_net stand-in: records the call instead of sending it.
CREATE TABLE net._http_log (id bigserial PRIMARY KEY, url text, body jsonb, headers jsonb, at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                              headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
                              timeout_milliseconds integer DEFAULT 5000) RETURNS bigint
  LANGUAGE sql AS $$ INSERT INTO net._http_log (url, body, headers) VALUES ($1, $2, $4) RETURNING id $$;
-- pgcrypto digest stand-in (sha256 only).
CREATE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE AS
  $$ SELECT CASE lower($2) WHEN 'sha256' THEN sha256(convert_to($1, 'UTF8')) END $$;

-- ---------------------------------------------------------------------------
-- Columns production has on tables race_stub.sql already created
-- ---------------------------------------------------------------------------
ALTER TABLE public.investor_portfolios
  ADD COLUMN invite_id uuid,
  ADD COLUMN duration_months integer,
  ADD COLUMN payment_method text,
  ADD COLUMN portfolio_pin text,
  ADD COLUMN activation_token uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN maturity_date date,
  ADD COLUMN next_roi_date date,
  ADD COLUMN total_roi_earned numeric NOT NULL DEFAULT 0,
  ADD COLUMN payout_day integer DEFAULT 15,
  ADD COLUMN auto_reinvest boolean NOT NULL DEFAULT false,
  ADD COLUMN investment_reference text,
  ADD COLUMN cfo_verified boolean DEFAULT false,
  ADD COLUMN cfo_verified_at timestamptz,
  ADD COLUMN cfo_verified_by uuid;
UPDATE public.investor_portfolios SET duration_months = 12, portfolio_pin = '1234';
ALTER TABLE public.investor_portfolios
  ALTER COLUMN duration_months SET NOT NULL,
  ALTER COLUMN portfolio_pin SET NOT NULL,
  ALTER COLUMN agent_id SET NOT NULL,
  ALTER COLUMN portfolio_code SET NOT NULL,
  ALTER COLUMN roi_mode SET NOT NULL;

ALTER TABLE public.profiles
  ADD COLUMN phone text, ADD COLUMN email text, ADD COLUMN signup_source text,
  ADD COLUMN funder_verified_at timestamptz, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
UPDATE public.profiles p SET email = u.email FROM auth.users u WHERE u.id = p.id;

ALTER TABLE public.audit_logs ADD COLUMN metadata jsonb DEFAULT '{}'::jsonb, ADD COLUMN action text;
ALTER TABLE public.system_events ADD COLUMN related_entity_type text, ADD COLUMN related_entity_id uuid, ADD COLUMN description text;

ALTER TABLE public.pending_wallet_operations
  ADD COLUMN user_id uuid, ADD COLUMN amount numeric, ADD COLUMN direction text, ADD COLUMN description text,
  ADD COLUMN transaction_group_id uuid, ADD COLUMN linked_party text, ADD COLUMN reference_id text,
  ADD COLUMN operation_type text NOT NULL DEFAULT 'standard', ADD COLUMN payment_method text,
  ADD COLUMN metadata jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE SEQUENCE public.hr_staff_ref_seq;
ALTER TABLE public.hr_staff
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN staff_ref text NOT NULL DEFAULT ('EMP-' || lpad(nextval('public.hr_staff_ref_seq')::text, 4, '0')),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- promissory_notes: NOT NULL columns get a fast default that is dropped again (no row rewrite).
ALTER TABLE public.promissory_notes
  ADD COLUMN partner_name text NOT NULL DEFAULT 'Legacy partner',
  ADD COLUMN IF NOT EXISTS whatsapp_number text NOT NULL DEFAULT '0700000000',
  ADD COLUMN IF NOT EXISTS phone_number text, ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN contribution_type text NOT NULL DEFAULT 'once_off',
  ADD COLUMN deduction_day integer, ADD COLUMN next_deduction_date date,
  ADD COLUMN support_mode text NOT NULL DEFAULT 'existing_support',
  ADD COLUMN approved_at timestamptz, ADD COLUMN total_collected numeric DEFAULT 0;
ALTER TABLE public.promissory_notes ALTER COLUMN partner_name DROP DEFAULT, ALTER COLUMN whatsapp_number DROP DEFAULT;

ALTER TABLE public.partner_agreements
  ADD COLUMN full_name text, ADD COLUMN partnership_amount numeric NOT NULL DEFAULT 0, ADD COLUMN partnership_amount_words text,
  ADD COLUMN return_option text, ADD COLUMN support_mode text, ADD COLUMN support_mode_set_at timestamptz,
  ADD COLUMN support_mode_set_by uuid, ADD COLUMN self_support_allowance numeric, ADD COLUMN auto_portfolio_id uuid,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.partner_agreements ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE public.funder_pending_portfolios
  ADD COLUMN funder_id uuid NOT NULL, ADD COLUMN amount numeric NOT NULL, ADD COLUMN source text NOT NULL,
  ADD COLUMN summary_id uuid, ADD COLUMN term_months integer NOT NULL DEFAULT 12,
  ADD COLUMN status text NOT NULL DEFAULT 'pending', ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN promissory_note_id uuid;
ALTER TABLE public.funder_pending_portfolios ALTER COLUMN portfolio_id SET NOT NULL;
CREATE UNIQUE INDEX funder_pending_portfolios_portfolio_id_key ON public.funder_pending_portfolios (portfolio_id);
-- Production's source check (pg_get_constraintdef read 2026-11-06 by the production rehearsal). It refuses
-- 'self_managed_house_topup', which the house top-up branch inserts (pre-existing defect, owner decision pending).
ALTER TABLE public.funder_pending_portfolios ADD CONSTRAINT funder_pending_portfolios_source_check
  CHECK (source = ANY (ARRAY['rent_pool'::text, 'self_managed'::text, 'self_managed_house'::text]));

ALTER TABLE public.partner_self_commitments
  ALTER COLUMN partner_id SET NOT NULL,
  ADD COLUMN committed_amount numeric NOT NULL, ADD COLUMN term_months integer NOT NULL DEFAULT 1,
  ADD COLUMN lines_count integer NOT NULL DEFAULT 0, ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN payout_anchor_at timestamptz, ADD COLUMN next_payout_at timestamptz, ADD COLUMN term_end_at timestamptz,
  ADD COLUMN idempotency_key text, ADD COLUMN promissory_note_id uuid,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX ux_psc_idempotency ON public.partner_self_commitments (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX ux_partner_self_commitments_promissory_note ON public.partner_self_commitments (promissory_note_id)
  WHERE promissory_note_id IS NOT NULL AND status <> 'cancelled';

ALTER TABLE public.partner_self_funding_lines
  ALTER COLUMN commitment_id SET NOT NULL,
  ADD COLUMN partner_id uuid NOT NULL, ADD COLUMN rent_request_id uuid NOT NULL, ADD COLUMN principal numeric NOT NULL,
  ADD COLUMN term_months integer NOT NULL DEFAULT 1,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.partner_self_funding_lines ALTER COLUMN status SET DEFAULT 'idle';

ALTER TABLE public.partner_supported_houses
  ADD COLUMN partner_id uuid NOT NULL, ADD COLUMN house_id uuid NOT NULL, ADD COLUMN principal numeric NOT NULL,
  ADD COLUMN term_months integer NOT NULL DEFAULT 1, ADD COLUMN status text NOT NULL DEFAULT 'pending',
  ADD COLUMN funding_tag text NOT NULL DEFAULT 'self_support_operational_house',
  ADD COLUMN landlord_id uuid, ADD COLUMN listing_agent_id uuid, ADD COLUMN supported_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN activated_at timestamptz, ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX ux_psh_house_live ON public.partner_supported_houses (house_id) WHERE status IN ('pending', 'active');

-- ---------------------------------------------------------------------------
-- Tables race_stub.sql does not have
-- ---------------------------------------------------------------------------
CREATE TABLE public.landlords (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, phone text NOT NULL,
  property_address text NOT NULL DEFAULT 'Kampala', created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.house_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), landlord_id uuid, agent_id uuid NOT NULL, title text NOT NULL,
  house_category text NOT NULL DEFAULT 'single_room', number_of_rooms integer NOT NULL DEFAULT 1,
  monthly_rent integer NOT NULL, region text NOT NULL DEFAULT 'Central', district text, sub_county text, village text,
  address text NOT NULL DEFAULT 'Plot 1', latitude double precision, longitude double precision, image_urls text[],
  status text NOT NULL DEFAULT 'available', tenant_id uuid, verified boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  is_hidden boolean NOT NULL DEFAULT false);

CREATE TABLE public.portfolio_allocations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), portfolio_id uuid NOT NULL,
  target_type text NOT NULL DEFAULT 'house', house_id uuid, rent_request_id uuid, claimed_amount numeric NOT NULL DEFAULT 0,
  claimed_basis text NOT NULL DEFAULT 'rent', status text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now(), pool_origin text NOT NULL DEFAULT 'company');

CREATE TABLE public.rent_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, agent_id uuid, landlord_id uuid NOT NULL,
  rent_amount numeric NOT NULL, duration_days integer NOT NULL DEFAULT 30, access_fee numeric NOT NULL DEFAULT 0,
  request_fee numeric NOT NULL DEFAULT 0, total_repayment numeric NOT NULL DEFAULT 0, daily_repayment numeric NOT NULL DEFAULT 0,
  status text DEFAULT 'pending', supporter_id uuid, approved_at timestamptz, funded_at timestamptz, disbursed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  number_of_payments integer DEFAULT 1, request_latitude double precision, request_longitude double precision,
  request_city text, house_category text, next_roi_due_date timestamptz, total_roi_paid numeric DEFAULT 0,
  roi_payments_count integer DEFAULT 0, house_image_urls text[] DEFAULT '{}'::text[],
  self_funding_partner_id uuid, self_funding_line_id uuid, funder_visible boolean NOT NULL DEFAULT true);
-- Production has dozens of row triggers here; one stand-in that touches updated_at.
CREATE FUNCTION public._rr_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_rr_touch BEFORE UPDATE ON public.rent_requests FOR EACH ROW EXECUTE FUNCTION public._rr_touch();

CREATE TABLE public.partner_self_plan_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rent_request_id uuid NOT NULL, partner_id uuid NOT NULL, amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'held', idempotency_key text, claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'), confirmed_at timestamptz, closed_at timestamptz,
  commitment_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX ux_pspc_active_plan ON public.partner_self_plan_claims (rent_request_id) WHERE status IN ('held', 'confirmed');
CREATE UNIQUE INDEX ux_pspc_idempotency ON public.partner_self_plan_claims (partner_id, rent_request_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Same column list and order as production; tenant/landlord details are placeholders.
CREATE VIEW public.v_partner_self_fundable_plans AS
SELECT rr.id AS rent_request_id, rr.rent_amount AS funding_amount, rr.rent_amount, rr.duration_days, rr.daily_repayment,
       rr.total_repayment, rr.number_of_payments, rr.house_category, rr.request_city, rr.house_image_urls,
       rr.created_at AS posted_at, rr.approved_at, (rr.created_at + interval '1 year')::date AS projected_end_date,
       'daily'::text AS repayment_cadence, 'Tenant'::text AS tenant_first_name, NULL::text AS tenant_avatar_url,
       'Landlord'::text AS landlord_name, c.id AS active_claim_id, c.partner_id AS held_by, c.expires_at AS hold_expires_at,
       'Tenant Example'::text AS tenant_full_name, rr.request_city AS tenant_location, false AS tenant_has_photo,
       rr.request_latitude, rr.request_longitude, NULL::text AS landlord_phone, NULL::text AS lc1_chairperson_name,
       NULL::text AS proxy_agent_phone, rr.funder_visible, NULL::text AS tenant_phone
  FROM public.rent_requests rr
  LEFT JOIN public.partner_self_plan_claims c ON c.rent_request_id = rr.id AND c.status = 'held' AND c.expires_at > now()
 WHERE rr.status = 'approved' AND rr.supporter_id IS NULL AND rr.self_funding_partner_id IS NULL;

CREATE TABLE public.promissory_note_plan_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note_id uuid NOT NULL, rent_request_id uuid NOT NULL, agent_id uuid NOT NULL,
  amount numeric NOT NULL, status text NOT NULL DEFAULT 'reserved', released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), commitment_id uuid,
  reserved_until timestamptz NOT NULL DEFAULT (now() + interval '7 days'));
CREATE UNIQUE INDEX idx_pnpi_live_plan ON public.promissory_note_plan_intents (rent_request_id) WHERE status = 'reserved';
CREATE UNIQUE INDEX promissory_note_plan_intents_unique ON public.promissory_note_plan_intents (note_id, rent_request_id);

CREATE TABLE public.promissory_note_house_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note_id uuid NOT NULL, house_id uuid NOT NULL, agent_id uuid NOT NULL,
  listing_agent_id uuid, monthly_rent numeric NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now(), reserved_until timestamptz DEFAULT (now() + interval '7 days'),
  promised_funding_date date, released_at timestamptz, funded_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, house_id));
CREATE UNIQUE INDEX ux_pnhi_house_reserved ON public.promissory_note_house_intents (house_id) WHERE status = 'reserved';

CREATE TABLE public.promissory_note_pledge_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note_id uuid NOT NULL UNIQUE, partner_name text NOT NULL, phone text, email text,
  amount numeric NOT NULL, attached_count integer NOT NULL DEFAULT 0, attached_amount numeric NOT NULL DEFAULT 0,
  monthly_return numeric NOT NULL DEFAULT 0, annual_return numeric NOT NULL DEFAULT 0, tenants jsonb NOT NULL DEFAULT '[]'::jsonb,
  sms_status text NOT NULL DEFAULT 'pending', email_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.promissory_house_booking_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note_id uuid NOT NULL, partner_user_id uuid, kind text NOT NULL,
  partner_name text, phone text, email text, house_count integer NOT NULL DEFAULT 0, total_rent numeric NOT NULL DEFAULT 0,
  promised_funding_date date, release_at timestamptz, days_left integer, houses jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (note_id, kind));

CREATE TABLE public.funder_house_progress_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dedupe_key text NOT NULL UNIQUE, kind text NOT NULL, partner_id uuid NOT NULL,
  supported_house_id uuid, house_id uuid, commitment_id uuid, partner_name text, email text, phone text, house_title text,
  district text, house_count integer NOT NULL DEFAULT 1, monthly_rent numeric NOT NULL DEFAULT 0, principal numeric NOT NULL DEFAULT 0,
  monthly_return numeric NOT NULL DEFAULT 0, agent_name text, placed_at timestamptz, earning_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.partner_lead_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_user_id uuid NOT NULL,
  agent_id uuid NOT NULL, attached_at timestamptz NOT NULL DEFAULT now(), detached_at timestamptz, reason text NOT NULL DEFAULT 'test');

CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL,
  message text NOT NULL, type text NOT NULL DEFAULT 'info', metadata jsonb DEFAULT '{}'::jsonb, is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), event_key text, link_path text);

-- Landlord payouts (only what partner_supported_house_returns reads).
CREATE TABLE public.agent_landlord_payouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,
  amount numeric NOT NULL DEFAULT 0, cfo_approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.wallet_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL, amount numeric NOT NULL, description text, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.portfolio_completion_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), portfolio_id uuid NOT NULL,
  partner_id uuid NOT NULL, token_hash text NOT NULL, email_snapshot text, phone_snapshot text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'), created_by uuid, created_at timestamptz NOT NULL DEFAULT now());

CREATE FUNCTION public.generate_short_code() RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT substr(md5(random()::text), 1, 8) $$;
CREATE TABLE public.short_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL DEFAULT public.generate_short_code() UNIQUE,
  user_id uuid NOT NULL, target_path text NOT NULL, target_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), resource_type text, resource_id uuid, og_title text, og_description text,
  og_image_url text, og_image_fingerprint text, og_updated_at timestamptz, destination_path text);
CREATE UNIQUE INDEX idx_short_links_user_params ON public.short_links (user_id, target_path, md5(target_params::text));
CREATE UNIQUE INDEX short_links_resource_owner_uniq ON public.short_links (user_id, resource_type, resource_id)
  WHERE resource_type IS NOT NULL AND resource_id IS NOT NULL;

CREATE TABLE public.general_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
  transaction_date timestamptz NOT NULL DEFAULT now(), amount numeric NOT NULL, direction text NOT NULL, category text NOT NULL,
  description text, reference_id text, user_id uuid, linked_party text, source_table text NOT NULL, source_id uuid,
  transaction_group_id uuid DEFAULT gen_random_uuid(), ledger_scope text NOT NULL DEFAULT 'wallet',
  currency text NOT NULL DEFAULT 'UGX', idempotency_key text, recipient_type text, wallet_bucket text);

CREATE TABLE public.supporter_roi_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rent_request_id uuid NOT NULL,
  supporter_id uuid NOT NULL, rent_amount numeric NOT NULL, roi_amount numeric NOT NULL, payment_number integer NOT NULL DEFAULT 1,
  due_date timestamptz NOT NULL, paid_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending');
CREATE UNIQUE INDEX idx_supporter_roi_unique ON public.supporter_roi_payments (rent_request_id, payment_number);

-- Payroll
CREATE TABLE public.hr_pay_periods (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, period_month date NOT NULL DEFAULT date_trunc('month', now())::date);
CREATE TABLE public.hr_pay_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), period_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft');
CREATE TABLE public.hr_pay_payslips (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, staff_id uuid NOT NULL,
  is_current boolean NOT NULL DEFAULT true, net numeric NOT NULL DEFAULT 0, inputs_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE public.hr_pay_payslip_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payslip_id uuid NOT NULL,
  component_code text NOT NULL, name text NOT NULL DEFAULT 'line', kind text NOT NULL DEFAULT 'deduction', amount numeric NOT NULL);
CREATE TABLE public.hr_pay_disbursements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payslip_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending');
CREATE TABLE public.hr_pay_staff_reinvestments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payslip_id uuid NOT NULL UNIQUE,
  run_id uuid NOT NULL, staff_id uuid NOT NULL, user_id uuid NOT NULL, amount numeric NOT NULL, percentage smallint,
  payout_mode text NOT NULL, portfolio_id uuid NOT NULL, kind text NOT NULL, pending_op_id uuid, ledger_group_id uuid,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.staff_surveys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL DEFAULT 'x', kind text NOT NULL);
CREATE TABLE public.staff_survey_responses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), survey_id uuid NOT NULL, user_id uuid NOT NULL,
  response text NOT NULL, percentage smallint, responded_at timestamptz NOT NULL DEFAULT now(),
  cycle_start date NOT NULL DEFAULT current_date, payout_mode text);

-- Test knob: operational float per person (default: plenty).
CREATE TABLE public._t_float (user_id uuid PRIMARY KEY, amount numeric NOT NULL);

-- ---------------------------------------------------------------------------
-- Helper functions (production signatures)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_phone_last9(phone text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE digits text;
BEGIN
  IF phone IS NULL THEN RETURN NULL; END IF;
  digits := regexp_replace(phone, '\D', '', 'g');
  IF length(digits) >= 9 THEN RETURN right(digits, 9); END IF;
  RETURN NULL;
END $$;

-- Production body (links a new note to a profile by phone at insert).
CREATE OR REPLACE FUNCTION public.link_promissory_note_partner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_uid uuid;
BEGIN
  IF NEW.partner_user_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT p.id INTO v_uid
  FROM profiles p
  WHERE normalize_phone_last9(p.phone) IS NOT NULL
    AND normalize_phone_last9(p.phone) IN (
      normalize_phone_last9(NEW.whatsapp_number),
      normalize_phone_last9(COALESCE(NEW.phone_number,''))
    )
  ORDER BY p.created_at
  LIMIT 1;
  IF v_uid IS NOT NULL THEN NEW.partner_user_id := v_uid; END IF;
  RETURN NEW;
END; $$;

-- Production body: registration links every matching note in ONE statement (owner side).
CREATE FUNCTION public.link_promissory_notes_for_user(p_user uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_phone9 text;
  v_email text;
  v_linked integer := 0;
BEGIN
  IF p_user IS NULL THEN RETURN 0; END IF;

  SELECT right(regexp_replace(COALESCE(p.phone,''), '\D', '', 'g'), 9),
         lower(NULLIF(btrim(COALESCE(p.email,'')), ''))
    INTO v_phone9, v_email
  FROM public.profiles p WHERE p.id = p_user;

  IF COALESCE(length(v_phone9),0) < 9 AND v_email IS NULL THEN RETURN 0; END IF;

  WITH linked AS (
    UPDATE public.promissory_notes n
       SET partner_user_id = p_user, updated_at = now()
     WHERE n.partner_user_id IS NULL
       AND n.status IN ('pending','activated')
       AND (
         (COALESCE(length(v_phone9),0) = 9 AND (
            right(regexp_replace(COALESCE(n.whatsapp_number,''), '\D', '', 'g'), 9) = v_phone9
            OR right(regexp_replace(COALESCE(n.phone_number,''), '\D', '', 'g'), 9) = v_phone9))
         OR (v_email IS NOT NULL AND lower(btrim(COALESCE(n.email,''))) = v_email)
       )
    RETURNING n.id, n.amount, n.agent_id
  )
  INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
  SELECT 'promissory.partner.auto_linked', p_user, 'promissory_notes', l.id,
         'Promissory note auto-linked to the partner account on registration',
         jsonb_build_object('amount', l.amount, 'agent_id', l.agent_id, 'match', 'phone_or_email')
  FROM linked l;

  GET DIAGNOSTICS v_linked = ROW_COUNT;
  RETURN v_linked;
END;
$$;

CREATE FUNCTION public.funder_has_signed_agreement(p_user_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.partner_agreements pa
                  WHERE pa.partner_id = p_user_id
                    AND (pa.countersigned_at IS NOT NULL OR pa.status IN ('signed','active','completed','countersigned','verified'))) $$;
CREATE FUNCTION public.assert_no_promissory_self_support(p_user uuid, p_path text) RETURNS void
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ BEGIN RETURN; END $$;   -- production: a no-op
CREATE FUNCTION public.funder_float_available(p_user_id uuid) RETURNS numeric
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT COALESCE((SELECT amount FROM public._t_float WHERE user_id = p_user_id), 1000000000) $$;
CREATE FUNCTION public.funder_float_capacity(p_user_id uuid) RETURNS numeric
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT public.funder_float_available(p_user_id) $$;
CREATE FUNCTION public.funder_pending_hold(p_user_id uuid) RETURNS numeric
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT 0::numeric $$;
CREATE FUNCTION public.psm_contract_term_months() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 12 $$;
CREATE FUNCTION public.psm_assert_no_foreign_booking(p_partner uuid, p_rent_request_ids uuid[]) RETURNS void
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.promissory_note_plan_intents i JOIN public.promissory_notes n ON n.id = i.note_id
   WHERE i.rent_request_id = ANY (COALESCE(p_rent_request_ids, '{}'::uuid[])) AND i.status = 'reserved'
     AND n.partner_user_id IS DISTINCT FROM p_partner;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'PLAN_BOOKED_BY_OTHER_PARTNER: % of the selected plans are booked on another partner''s promissory note.', v_n
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
CREATE FUNCTION public.psm_audit(p_actor uuid, p_partner uuid, p_action text, p_entity_type text, p_entity_id uuid, p_metadata jsonb)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (p_actor, p_action, p_entity_type, p_entity_id::text, p_metadata || jsonb_build_object('partner_id', p_partner)) $$;
CREATE FUNCTION public.house_has_live_claim(p_house_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.promissory_note_house_intents i
     WHERE i.house_id = p_house_id AND i.status IN ('reserved','funded')
    UNION ALL
    SELECT 1 FROM public.partner_supported_houses psh
     WHERE psh.house_id = p_house_id AND psh.status IN ('pending','active')
    UNION ALL
    SELECT 1 FROM public.portfolio_allocations a
     WHERE a.house_id = p_house_id AND a.status IN ('reserved','fulfilled')
  ) $$;
CREATE FUNCTION public.is_ops_role(_user_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND enabled = true
                    AND role IN ('manager','super_admin','coo','operations')) $$;
CREATE FUNCTION public.is_partner_ops(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid
                    AND role::text IN ('manager','coo','super_admin','cto','partner_ops','ceo','director')) $$;
CREATE FUNCTION public.can_view_staff_reports(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(auth.role(), 'service_role') = 'service_role'
      OR (_uid IS NOT NULL AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _uid AND ur.enabled
            AND ur.role IN ('manager','super_admin','coo','ceo','cto','cfo','partner_ops','financial_ops'))) $$;
CREATE FUNCTION public._partner_contract_coverage(p_partner_id uuid) RETURNS TABLE(existing_total numeric, existing_count integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(sum(ip.investment_amount), 0)::numeric, count(*)::int
    FROM public.investor_portfolios ip
   WHERE ip.investor_id = p_partner_id
     AND ip.status IN ('active', 'locked', 'pending_ops_approval', 'awaiting_partner_details', 'matured') $$;
-- Production body.
CREATE FUNCTION public.partner_self_topup_eligibility(p_commitment_id uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  c public.partner_self_commitments%ROWTYPE;
  v_days_remaining integer;
  v_allow boolean;
  v_reason text;
  v_lockout_days integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.partner_self_commitments WHERE id = p_commitment_id AND partner_id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'no_data_found'; END IF;
  v_lockout_days := CASE WHEN COALESCE(c.term_months, public.psm_contract_term_months()) <= 3 THEN 5 ELSE 90 END;
  v_days_remaining := GREATEST(0, COALESCE(c.term_end_at::date, CURRENT_DATE) - CURRENT_DATE);
  IF c.status <> 'active' THEN
    v_allow := false; v_reason := 'This portfolio is ' || c.status || '. New capital starts a fresh monthly portfolio.';
  ELSIF c.term_end_at IS NOT NULL AND v_days_remaining <= v_lockout_days THEN
    v_allow := false; v_reason := 'This portfolio matures soon.';
  ELSE
    v_allow := true; v_reason := NULL;
  END IF;
  RETURN jsonb_build_object('commitment_id', c.id, 'status', c.status, 'monthly_rate', c.monthly_rate,
                            'allow_topup', v_allow, 'block_reason', v_reason);
END $$;

-- Ledger: records the legs and returns the group (idempotent by key, like production).
CREATE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL::text,
                                                 skip_balance_check boolean DEFAULT false) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_group uuid;
BEGIN
  IF entries IS NULL OR jsonb_typeof(entries) <> 'array' THEN RAISE EXCEPTION 'entries must be a JSON array'; END IF;
  IF idempotency_key IS NOT NULL AND idempotency_key <> '' THEN
    PERFORM pg_advisory_xact_lock(abs(hashtext(idempotency_key)));
    SELECT g.transaction_group_id INTO v_group FROM public.general_ledger g
     WHERE g.idempotency_key = create_ledger_transaction.idempotency_key LIMIT 1;
    IF v_group IS NOT NULL THEN RETURN v_group; END IF;
  END IF;
  v_group := gen_random_uuid();
  INSERT INTO public.general_ledger (amount, direction, category, description, reference_id, user_id, linked_party,
                                     source_table, source_id, transaction_group_id, ledger_scope, idempotency_key,
                                     recipient_type, wallet_bucket)
  SELECT (e ->> 'amount')::numeric, e ->> 'direction', e ->> 'category', e ->> 'description', e ->> 'reference_id',
         (e ->> 'user_id')::uuid, e ->> 'linked_party', COALESCE(e ->> 'source_table', 'unknown'), (e ->> 'source_id')::uuid,
         v_group, COALESCE(e ->> 'ledger_scope', 'wallet'), NULLIF(create_ledger_transaction.idempotency_key, ''),
         e ->> 'recipient_type', e ->> 'wallet_bucket'
    FROM jsonb_array_elements(entries) e;
  RETURN v_group;
END $$;

-- ---------------------------------------------------------------------------
-- The functions Phase 2 replaces, as they stand in production (signature, return type, ACL);
-- placeholder bodies. Phase 2 must replace every one of them without a signature error.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.agent_create_promissory_note(p_payload jsonb, p_rent_request_ids uuid[] DEFAULT '{}'::uuid[]) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.agent_create_promissory_note_for_houses(p_payload jsonb, p_house_ids uuid[] DEFAULT '{}'::uuid[]) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.agent_list_empty_house_opportunities(p_search text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0, p_district text DEFAULT NULL::text, p_verified_only boolean DEFAULT false, p_gps_only boolean DEFAULT false, p_min_rent numeric DEFAULT NULL::numeric, p_max_rent numeric DEFAULT NULL::numeric, p_near_lat double precision DEFAULT NULL::double precision, p_near_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision, p_sort text DEFAULT NULL::text) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.countersign_prepare_support(p_partner_id uuid, p_amount numeric, p_support_mode text, p_return_option text, p_actor uuid, p_countersign_only boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.create_pending_portfolio(p_partner_id uuid, p_amount numeric, p_duration_months integer, p_roi_percentage numeric, p_roi_mode text, p_nickname text, p_raw_token text) RETURNS TABLE(portfolio_id uuid, portfolio_code text) LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::text $$;
CREATE FUNCTION public.empty_house_opportunity_summary() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.enqueue_funder_house_notice(p_dedupe_key text, p_kind text, p_partner_id uuid, p_supported_house_id uuid, p_house_id uuid, p_commitment_id uuid, p_house_title text, p_district text, p_house_count integer, p_monthly_rent numeric, p_principal numeric, p_agent_name text, p_placed_at timestamp with time zone, p_earning_started_at timestamp with time zone) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.funder_create_pending_portfolio(p_amount numeric, p_summary_id uuid DEFAULT NULL::uuid, p_term_months integer DEFAULT 12) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.get_countersign_summary(p_partner_id uuid, p_amount numeric DEFAULT NULL::numeric) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.get_or_create_house_share_link(p_house_id uuid) RETURNS TABLE(code text, og_title text, og_description text, og_image_url text, destination_path text, created boolean) LANGUAGE sql AS $$ SELECT NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::boolean $$;
CREATE FUNCTION public.get_or_create_plan_share_link(p_plan_id uuid) RETURNS TABLE(code text, og_title text, og_description text, og_image_url text, destination_path text, created boolean) LANGUAGE sql AS $$ SELECT NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::boolean $$;
CREATE FUNCTION public.get_supporter_pool_stats() RETURNS json LANGUAGE sql AS $$ SELECT '{"old":true}'::json $$;
CREATE FUNCTION public.hr_pay_post_staff_reinvestment(_payslip_id uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_commitment_id uuid DEFAULT NULL::uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.post_rent_facilitation_reward(p_rent_request_id uuid, p_payment_number integer, p_reinvest_portfolio_id uuid DEFAULT NULL::uuid, p_wallet_description text DEFAULT NULL::text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.psm_confirm_commitment_for(p_partner uuid, p_rent_request_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_actor uuid DEFAULT NULL::uuid, p_promissory_note_id uuid DEFAULT NULL::uuid, p_funding_mode text DEFAULT 'float'::text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.psm_queue_house_booking_notice(p_note_id uuid, p_kind text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.psm_queue_promissory_pledge_notice(p_note_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.public_house_support_offer(p_code text) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"old":true}'::jsonb $$;
CREATE FUNCTION public.public_support_plan(p_plan_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"old":true}'::jsonb $$;

-- partner_supported_house_returns: the PRODUCTION text (Phase 2 replaces it). Rebuilt from the Phase 2 text with the
-- fixed 0.15 put back and its new return_rate key removed; md5(pg_get_functiondef) must equal the production
-- fingerprint in prod_function_manifest.json (ce1176237dea4005406c7e0434dce8f6, checked by phase2_test.sql).
-- A copy is kept as _t_old_house_returns() for the parity checks; grants as in 20260830145756 (authenticated).
CREATE OR REPLACE FUNCTION public.partner_supported_house_returns()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_phone text;
  v_rows jsonb := '[]'::jsonb;
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala'))::date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  SELECT lower(btrim(COALESCE(p.email, ''))), regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')
    INTO v_email, v_phone
  FROM public.profiles p WHERE p.id = v_uid;

  WITH my_notes AS (
    SELECT n.*
    FROM public.promissory_notes n
    WHERE n.partner_user_id = v_uid
       OR (NULLIF(v_email, '') IS NOT NULL AND lower(btrim(COALESCE(n.email, ''))) = v_email)
       OR (
         NULLIF(v_phone, '') IS NOT NULL AND length(v_phone) >= 9 AND (
           right(regexp_replace(COALESCE(n.phone_number, ''), '\D', '', 'g'), 9) = right(v_phone, 9)
           OR right(regexp_replace(COALESCE(n.whatsapp_number, ''), '\D', '', 'g'), 9) = right(v_phone, 9)
         )
       )
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'intent_id', i.id,
    'note_id', n.id,
    'house_id', h.id,
    'title', h.title,
    'district', h.district,
    'sub_county', h.sub_county,
    'village', h.village,
    'monthly_rent', COALESCE(i.monthly_rent, h.monthly_rent, 0),
    'monthly_return', round(COALESCE(i.monthly_rent, h.monthly_rent, 0) * 0.15),
    'annual_return', round(COALESCE(i.monthly_rent, h.monthly_rent, 0) * 0.15 * 12),
    'intent_status', i.status,
    'note_status', n.status,
    'promised_amount', COALESCE(n.amount, 0),
    'collected_amount', COALESCE(n.total_collected, 0),
    'is_funded', (n.status = 'activated' OR COALESCE(n.total_collected, 0) > 0),
    'tenant_activated', (h.tenant_id IS NOT NULL),
    'tenant_name', tp.full_name,
    'listing_agent_name', ap.full_name,
    'monthly_paid_this_month', EXISTS (
      SELECT 1 FROM public.agent_landlord_payouts pay
      WHERE pay.tenant_id = h.tenant_id
        AND pay.cfo_approved_at IS NOT NULL
        AND (pay.cfo_approved_at AT TIME ZONE 'Africa/Kampala')::date >= v_month_start
    ),
    'last_paid_at', (
      SELECT max(pay.cfo_approved_at) FROM public.agent_landlord_payouts pay
      WHERE pay.tenant_id = h.tenant_id AND pay.cfo_approved_at IS NOT NULL
    ),
    'created_at', i.created_at
  ) ORDER BY i.created_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM public.promissory_note_house_intents i
  JOIN my_notes n ON n.id = i.note_id
  JOIN public.house_listings h ON h.id = i.house_id
  LEFT JOIN public.profiles tp ON tp.id = h.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = i.listing_agent_id;

  RETURN jsonb_build_object(
    'houses', v_rows,
    'total_monthly_return', COALESCE((SELECT SUM((x->>'monthly_return')::numeric) FROM jsonb_array_elements(v_rows) x), 0),
    'total_annual_return', COALESCE((SELECT SUM((x->>'annual_return')::numeric) FROM jsonb_array_elements(v_rows) x), 0),
    'house_count', jsonb_array_length(v_rows)
  );
END;
$function$
;
CREATE TABLE public._t_prod_fp AS
  SELECT 'partner_supported_house_returns()'::text AS fn,
         md5(pg_get_functiondef('public.partner_supported_house_returns()'::regprocedure)) AS md5;
DO $c$ BEGIN
  EXECUTE replace(pg_get_functiondef('public.partner_supported_house_returns()'::regprocedure),
                  'FUNCTION public.partner_supported_house_returns(', 'FUNCTION public._t_old_house_returns(');
END $c$;

-- Production's RLS on the two notice queues (pg_policies read 2026-11-06, round 4; app_role values are text here).
-- Their table grants were not read: authenticated gets SELECT here, so the policies are the gate, as RLS is in production.
ALTER TABLE public.promissory_note_pledge_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Agents view own pledge notices" ON public.promissory_note_pledge_notices FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.promissory_notes n WHERE n.id = promissory_note_pledge_notices.note_id AND n.agent_id = (SELECT auth.uid())));
CREATE POLICY "Ops view pledge notices" ON public.promissory_note_pledge_notices FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (SELECT auth.uid())
                    AND ur.role = ANY (ARRAY['operations','cfo','coo','super_admin','manager','partner_ops'])));
CREATE POLICY mfa_required_for_staff ON public.promissory_note_pledge_notices AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
ALTER TABLE public.promissory_house_booking_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY phbn_owner_or_ops_read ON public.promissory_house_booking_notices FOR SELECT TO authenticated
  USING ((partner_user_id = (SELECT auth.uid())) OR (SELECT public.is_ops_role((SELECT auth.uid()))));
CREATE POLICY mfa_required_for_staff ON public.promissory_house_booking_notices AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
GRANT SELECT ON public.promissory_note_pledge_notices, public.promissory_house_booking_notices TO authenticated;

-- Production ACLs (proacl read 2026-11-06).
DO $acl$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS fn, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN (
              'agent_create_promissory_note','agent_create_promissory_note_for_houses','agent_list_empty_house_opportunities',
              'countersign_prepare_support','create_pending_portfolio','empty_house_opportunity_summary','enqueue_funder_house_notice',
              'funder_create_pending_portfolio','get_countersign_summary','get_or_create_house_share_link','get_or_create_plan_share_link',
              'get_supporter_pool_stats','hr_pay_post_staff_reinvestment','partner_support_houses','post_rent_facilitation_reward',
              'psm_confirm_commitment_for','psm_queue_house_booking_notice','psm_queue_promissory_pledge_notice',
              'public_house_support_offer','public_support_plan','partner_supported_house_returns')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.fn);
    IF r.proname NOT IN ('countersign_prepare_support','enqueue_funder_house_notice','hr_pay_post_staff_reinvestment',
                         'post_rent_facilitation_reward','psm_confirm_commitment_for','psm_queue_house_booking_notice',
                         'psm_queue_promissory_pledge_notice') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.fn);
    END IF;
    IF r.proname IN ('public_house_support_offer', 'public_support_plan') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', r.fn);
    END IF;
    IF r.proname = 'public_house_support_offer' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', r.fn);
    END IF;
    IF r.proname = 'public_support_plan' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticator', r.fn);
    END IF;
  END LOOP;
END $acl$;
CREATE TABLE public._t_acl_before AS
  SELECT p.oid::regprocedure::text AS fn, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN (
     'agent_create_promissory_note','agent_create_promissory_note_for_houses','agent_list_empty_house_opportunities',
     'countersign_prepare_support','create_pending_portfolio','empty_house_opportunity_summary','enqueue_funder_house_notice',
     'funder_create_pending_portfolio','get_countersign_summary','get_or_create_house_share_link','get_or_create_plan_share_link',
     'get_supporter_pool_stats','hr_pay_post_staff_reinvestment','partner_support_houses','post_rent_facilitation_reward',
     'psm_confirm_commitment_for','psm_queue_house_booking_notice','psm_queue_promissory_pledge_notice',
     'public_house_support_offer','public_support_plan','partner_supported_house_returns');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role, authenticated;

-- ---------------------------------------------------------------------------
-- Staff identities used by Phase 2 tests
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  (public.pid('pops'), 'pops@welile.test'), (public.pid('supporter1'), 'supporter1@welile.test'),
  (public.pid('plain'), 'plain@welile.test');
INSERT INTO public.user_roles (user_id, role, enabled) VALUES
  (public.pid('pops'), 'partner_ops', true), (public.pid('supporter1'), 'supporter', true);
INSERT INTO public.profiles (id, full_name, email) VALUES
  (public.pid('pops'), 'pops', 'pops@welile.test'), (public.pid('supporter1'), 'Supporter One', 'supporter1@welile.test'),
  (public.pid('plain'), 'plain', 'plain@welile.test');

-- ---------------------------------------------------------------------------
-- Pre-migration data
-- ---------------------------------------------------------------------------
-- A legacy rent-facilitation funding (supporter set before Phase 2) and one never funded.
INSERT INTO public.rent_requests (id, tenant_id, landlord_id, rent_amount, status, supporter_id, funded_at)
VALUES (public.pid('rr_legacy'), public.pid('tenant1'), public.pid('landlord1'), 600000, 'funded', public.pid('legacy_supporter'),
        timestamptz '2026-09-01 09:00+03'),
       (public.pid('rr_unfunded'), public.pid('tenant2'), public.pid('landlord1'), 400000, 'approved', NULL, NULL),
       -- For the backfill re-decide test (phase2_between_applies.sql): its supporter is changed between the two
       -- Phase 2 applies with the stamp trigger off; rr_same keeps its supporter (its stored rate must not move).
       (public.pid('rr_moved'), public.pid('tenant3'), public.pid('landlord1'), 500000, 'funded', public.pid('moved_from'),
        timestamptz '2026-09-10 09:00+03'),
       (public.pid('rr_same'), public.pid('tenant4'), public.pid('landlord1'), 300000, 'funded', public.pid('same_supporter'),
        timestamptz '2026-09-12 09:00+03');
