-- Throwaway stand-ins for the production objects Partner Returns Phase 4 (4a, 4a-assistant, 4b) reads.
-- LOCAL TEST CLUSTER ONLY. Load after race_stub.sql + race_stub_phase2.sql, before the 4b rollback file (which
-- replaces the five reader placeholders below with their byte-exact production text and checks the md5s).
-- Shapes follow production as read 2026-11-07 (columns, ACLs, signatures). Run by run_phase4_tests.sh.
-- (Replaces the 5 Nov stub of the superseded per-contract design.)

-- auth.users: the confirmations the activation RPC (D3) and partner_confirmed_login_emails read.
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS phone_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- promissory_notes.activation_token: production has a plain (non-unique) index; values are 64 hex characters.
ALTER TABLE public.promissory_notes
  ADD COLUMN activation_token text NOT NULL DEFAULT (md5(random()::text) || md5(random()::text));
CREATE INDEX promissory_notes_activation_token ON public.promissory_notes (activation_token);

-- Send state of the notice queues (4a's backfill and the open_notices_carry_rate check read them).
ALTER TABLE public.promissory_house_booking_notices
  ADD COLUMN sms_sent_at timestamptz, ADD COLUMN sms_error text, ADD COLUMN email_sent_at timestamptz, ADD COLUMN email_error text;
ALTER TABLE public.funder_house_progress_notices
  ADD COLUMN sms_sent_at timestamptz, ADD COLUMN sms_error text, ADD COLUMN email_sent_at timestamptz, ADD COLUMN email_error text;

DO $$ BEGIN
  IF to_regtype('public.app_role') IS NULL THEN
    CREATE TYPE public.app_role AS ENUM ('tenant', 'agent', 'landlord', 'supporter', 'partner_ops', 'coo', 'cfo', 'ceo',
      'super_admin', 'manager', 'financial_ops', 'operations', 'cto', 'agent_ops', 'investor', 'senior_agent', 'sub_agent');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_email_lower ON public.profiles (lower(email));

-- pg_cron run log (the report's monitor reads the newest run by runid).
CREATE TABLE cron.job_run_details (runid bigserial PRIMARY KEY, jobid bigint, job_pid integer, database text, username text,
  command text, status text, return_message text, start_time timestamptz, end_time timestamptz);

CREATE TABLE public.proxy_agent_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL, beneficiary_id uuid NOT NULL,
  beneficiary_role text NOT NULL, assigned_by uuid NOT NULL DEFAULT gen_random_uuid(), reason text,
  is_active boolean NOT NULL DEFAULT true, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), is_managed_account boolean NOT NULL DEFAULT false,
  approval_status text NOT NULL DEFAULT 'pending', approved_by uuid, approved_at timestamptz, rejection_reason text);
CREATE TABLE public.withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, agent_id uuid, initiated_by uuid, proxy_partner_id uuid,
  linked_party uuid, status text, reason text, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.general_ledger ADD COLUMN classification text;

-- Functions the production readers call (production signatures; bodies are stand-ins).
CREATE FUNCTION public.get_agent_proxy_roi_payouts(p_agent_id uuid DEFAULT auth.uid())
 RETURNS TABLE(id uuid, amount numeric, linked_party text, source_id uuid, target_wallet_user_id uuid, description text,
               metadata jsonb, created_at timestamp with time zone, reviewed_at timestamp with time zone)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
 $$ SELECT NULL::uuid, NULL::numeric, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::jsonb, NULL::timestamptz, NULL::timestamptz WHERE false $$;
CREATE FUNCTION public._direct_client_call() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.agent_wallet_network_ids(uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT NULL::uuid WHERE false $$;
CREATE FUNCTION public.is_customer_wallet_history_visible(uuid, text, text, text, text, text, uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION public.get_user_wallet_view(uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT jsonb_build_object('withdrawable', 1000, 'float_balance', 200, 'advance_balance', 0, 'pending_holds', 0, 'restricted_held', 0) $$;
-- Production's impl computes ~40 figures; the stand-in returns the keys 4b masks plus a few others, reading the person's
-- portfolios so the figures are not constants.
CREATE FUNCTION public._get_user_trust_profile_impl(p_user_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public' AS $$
DECLARE v_val numeric; v_earned numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id) THEN RETURN jsonb_build_object('error', 'AI ID not found'); END IF;
  SELECT COALESCE(sum(investment_amount), 0), COALESCE(sum(total_roi_earned), 0) INTO v_val, v_earned
    FROM public.investor_portfolios WHERE investor_id = p_user_id AND status = 'active';
  RETURN jsonb_build_object(
    'ai_id', 'WEL-' || UPPER(SUBSTRING(REPLACE(p_user_id::text,'-',''), 1, 6)), 'user_id', p_user_id,
    'identity', jsonb_build_object('full_name', 'x', 'is_supporter', true, 'roles', jsonb_build_array('supporter')),
    'trust', jsonb_build_object('score', 50),
    'permissions', jsonb_build_object('can_see_pii', false),
    'payment_history', jsonb_build_object('total_rent_plans', 0, 'on_time_rate', 0),
    'cash_flow_capacity', jsonb_build_object('daily_avg', 500, 'weekly_avg', 3500, 'monthly_avg', 15000, 'wallet_monthly', 0,
                                             'roi_monthly', 15000, 'inflow_30d', 0, 'outflow_30d', 0, 'window_days', 90),
    'supporter_activity', jsonb_build_object('is_supporter', true, 'portfolio_value', v_val, 'active_portfolios', 1,
                                             'total_roi_earned', v_earned, 'roi_paid_30d', 15000, 'roi_paid_180d', 90000,
                                             'roi_monthly_avg', 15000, 'angel_shares_ugx', 0),
    'network', jsonb_build_object('referrals', 0), 'agent_performance', jsonb_build_object('qualifying_tenants', 0),
    'behavior', jsonb_build_object('visits_total_60d', 0), 'landlord_activity', jsonb_build_object('total_listings', 0));
END $$;
REVOKE ALL ON FUNCTION public._get_user_trust_profile_impl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._get_user_trust_profile_impl(uuid) TO service_role;
-- 20261105110000_assistant_partner_tools (origin/lovable): refuses a caller without an enabled supporter role.
CREATE FUNCTION public.assistant_require_partner() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'supporter' AND enabled) THEN
    RAISE EXCEPTION 'not a partner' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.assistant_require_partner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assistant_require_partner() TO authenticated, service_role;

-- The five readers as in production (placeholders with the production signatures and ACLs; the 4b rollback file then
-- replaces them with the byte-exact production text and checks the md5s).
CREATE FUNCTION public.get_portfolio_by_activation_token(p_token uuid)
 RETURNS TABLE(portfolio_code text, investment_amount numeric, duration_months integer, roi_percentage numeric, roi_mode text, status text, created_at timestamp with time zone, next_roi_date date, maturity_date date, total_roi_earned numeric, agent_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT NULL::text, 0::numeric, 0, 0::numeric, NULL::text, NULL::text, now(), NULL::date, NULL::date, 0::numeric, NULL::text WHERE false $$;
CREATE FUNCTION public.agent_onboarded_portfolios()
 RETURNS TABLE(portfolio_id uuid, investor_id uuid, partner_name text, portfolio_code_masked text, investment_amount numeric, total_roi_earned numeric, roi_percentage numeric, duration_months integer, status text, created_at timestamp with time zone, next_roi_date date, maturity_date date)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, 0::numeric, 0::numeric, 0::numeric, 0, NULL::text, now(), NULL::date, NULL::date WHERE false $$;
CREATE FUNCTION public.get_user_trust_profile(p_ai_id text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION public.get_public_trust_profile(p_ai_id text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION public.get_partner_wallet_hub(p_user_id uuid, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS TABLE(withdrawable_amount numeric, float_amount numeric, advance_amount numeric, roi_amount numeric, deposits_amount numeric, total_available numeric, pending_holds numeric, restricted_held numeric, recent_transactions jsonb)
 LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, '[]'::jsonb WHERE false $$;
REVOKE ALL ON FUNCTION public.get_portfolio_by_activation_token(uuid), public.agent_onboarded_portfolios(),
  public.get_user_trust_profile(text), public.get_partner_wallet_hub(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_portfolio_by_activation_token(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_onboarded_portfolios(), public.get_user_trust_profile(text),
  public.get_partner_wallet_hub(uuid, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_trust_profile(text) TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.proxy_agent_assignments, public.withdrawal_requests TO service_role;
