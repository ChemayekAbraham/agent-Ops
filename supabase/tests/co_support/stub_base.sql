-- Throwaway local stub of the production objects co-support touches.
-- Tables carry only the columns the code uses; helpers are simplified.
-- Live function bodies (md5-checked) are appended by build_base.js.
SET client_min_messages = warning;
SET check_function_bodies = off;
SET client_encoding = 'UTF8';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

-- ---------- reference + people ----------
CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, phone text, village text, city text,
  district text, region text, avatar_url text);
CREATE TABLE public.landlords (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, phone text,
  mobile_money_number text, tenant_id uuid);
CREATE TABLE public.lc1_chairpersons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.t_partners (user_id uuid PRIMARY KEY, signed boolean DEFAULT true, rate numeric DEFAULT 15);
CREATE TABLE public.pipeline_switches (key text PRIMARY KEY, is_on boolean);
INSERT INTO public.pipeline_switches VALUES ('funder_direct_release', true);
CREATE TABLE public.self_support_fee_policy (id boolean PRIMARY KEY DEFAULT true, enabled boolean, rate numeric,
  round_to numeric DEFAULT 100);
INSERT INTO public.self_support_fee_policy VALUES (true, true, 0.02, 100);

CREATE TABLE public.rent_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, agent_id uuid, assigned_agent_id uuid,
  landlord_id uuid, lc1_id uuid, proxy_agent_id uuid, rent_amount numeric NOT NULL, duration_days int DEFAULT 30,
  daily_repayment numeric DEFAULT 0, total_repayment numeric DEFAULT 0, number_of_payments int DEFAULT 30,
  house_category text, request_city text, house_image_urls text[], created_at timestamptz DEFAULT now(),
  coo_reviewed_at timestamptz DEFAULT now(), approved_at timestamptz, funded_at timestamptz, disbursed_at timestamptz,
  supporter_id uuid, self_funding_partner_id uuid, self_funding_line_id uuid, tenancy_status text DEFAULT 'active',
  funder_visible boolean DEFAULT true, status text DEFAULT 'coo_approved', request_latitude float8,
  request_longitude float8, updated_at timestamptz DEFAULT now(), fund_recipient_type text, fund_recipient_id uuid,
  fund_recipient_name text, fund_routed_at timestamptz);
CREATE TABLE public.agent_landlord_float (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid UNIQUE,
  balance numeric DEFAULT 0, total_funded numeric DEFAULT 0, total_paid_out numeric DEFAULT 0, updated_at timestamptz);
CREATE TABLE public.t_staff (user_id uuid PRIMARY KEY);
CREATE FUNCTION public.is_partner_ops(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT EXISTS (SELECT 1 FROM public.t_staff WHERE user_id = p_uid) $$;

-- ---------- self-support tables (live columns) ----------
CREATE TABLE public.partner_self_plan_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rent_request_id uuid,
  partner_id uuid, amount numeric, status text DEFAULT 'held', idempotency_key text, claimed_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '10 minutes'), confirmed_at timestamptz, closed_at timestamptz,
  commitment_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX ux_pspc_active_plan ON public.partner_self_plan_claims (rent_request_id)
  WHERE status = ANY (ARRAY['held','confirmed']);
CREATE UNIQUE INDEX ux_pspc_idempotency ON public.partner_self_plan_claims (partner_id, rent_request_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE public.partner_self_commitments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_id uuid,
  committed_amount numeric, term_months int DEFAULT 1, monthly_rate numeric DEFAULT 15, lines_count int DEFAULT 0,
  status text DEFAULT 'active', payout_anchor_at timestamptz, payout_day smallint, next_payout_at timestamptz,
  term_end_at timestamptz, total_earned numeric DEFAULT 0, total_paid numeric DEFAULT 0, idempotency_key text,
  ledger_group_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), promissory_note_id uuid);

CREATE TABLE public.partner_self_funding_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), commitment_id uuid,
  partner_id uuid, rent_request_id uuid, principal numeric, monthly_rate numeric DEFAULT 15, term_months int DEFAULT 1,
  status text DEFAULT 'idle', committed_at timestamptz DEFAULT now(), live_at timestamptz, term_end_at timestamptz,
  completed_at timestamptz, total_earned numeric DEFAULT 0, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), plan_closed_at timestamptz, end_reason text, rent_amount numeric,
  proxy_fee numeric DEFAULT 0, proxy_fee_status text, proxy_agent_id uuid, proxy_fee_ledger_group_id uuid);
CREATE UNIQUE INDEX ux_psfl_active_plan ON public.partner_self_funding_lines (rent_request_id) WHERE status <> 'cancelled';


CREATE TABLE public.funder_pending_portfolios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), portfolio_id uuid,
  funder_id uuid, amount numeric, source text, summary_id uuid, commitment_id uuid, term_months int DEFAULT 12,
  status text DEFAULT 'pending', reviewed_by uuid, reviewed_at timestamptz, review_reason text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), promissory_note_id uuid);

CREATE TABLE public.investor_portfolios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), investor_id uuid,
  agent_id uuid NOT NULL, portfolio_code text NOT NULL, investment_amount numeric NOT NULL, duration_months int NOT NULL,
  roi_percentage numeric, roi_mode text, status text, portfolio_pin text NOT NULL, activation_token uuid,
  created_at timestamptz DEFAULT now(), maturity_date date, next_roi_date date, total_roi_earned numeric);
-- stand-in for the rate gate: stamps the person's own rate
CREATE FUNCTION public.t_stamp_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.roi_percentage := COALESCE(NEW.roi_percentage, public.partner_rate_now(NEW.investor_id)); RETURN NEW; END $$;
CREATE TRIGGER t_stamp_rate BEFORE INSERT ON public.investor_portfolios FOR EACH ROW EXECUTE FUNCTION public.t_stamp_rate();

-- ---------- money ----------
CREATE TABLE public.general_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT clock_timestamp(),
  amount numeric NOT NULL, direction text NOT NULL, category text NOT NULL, description text, reference_id text,
  user_id uuid, linked_party text, source_table text, source_id uuid, ledger_scope text, idempotency_key text,
  transaction_group_id uuid, recipient_type text, wallet_bucket text);

CREATE FUNCTION public.get_user_float_available_balance(p_user_id uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END),0)
    FROM public.general_ledger WHERE ledger_scope='wallet' AND user_id=p_user_id AND wallet_bucket='float' $$;

CREATE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL, skip_balance_check boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_group uuid; e jsonb; v_user uuid;
BEGIN
  IF idempotency_key IS NOT NULL THEN
    SELECT g.transaction_group_id INTO v_group FROM public.general_ledger g WHERE g.idempotency_key = create_ledger_transaction.idempotency_key LIMIT 1;
    IF FOUND THEN RETURN v_group; END IF;
  END IF;
  v_group := gen_random_uuid();
  FOR e IN SELECT * FROM jsonb_array_elements(entries) LOOP
    INSERT INTO public.general_ledger (amount, direction, category, description, reference_id, user_id, linked_party,
      source_table, source_id, ledger_scope, idempotency_key, transaction_group_id, recipient_type, wallet_bucket)
    VALUES ((e->>'amount')::numeric, e->>'direction', e->>'category', e->>'description', e->>'reference_id',
      NULLIF(e->>'user_id','')::uuid, e->>'linked_party', e->>'source_table', NULLIF(e->>'source_id','')::uuid,
      e->>'ledger_scope', create_ledger_transaction.idempotency_key, v_group, e->>'recipient_type', e->>'wallet_bucket');
    IF e->>'ledger_scope' = 'wallet' AND e->>'direction' = 'cash_out' AND NOT skip_balance_check THEN
      v_user := (e->>'user_id')::uuid;
      IF public.get_user_float_available_balance(v_user) < 0 THEN
        RAISE EXCEPTION 'INSUFFICIENT_WALLET_BALANCE for %', v_user;
      END IF;
    END IF;
  END LOOP;
  RETURN v_group;
END $$;

CREATE TABLE public.agent_landlord_float_allocations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL,
  tenant_id uuid, rent_request_id uuid, landlord_id uuid, landlord_name text, landlord_phone text, allocated_amount numeric,
  paid_out_amount numeric DEFAULT 0, status text DEFAULT 'open', source text, funded_by_partner_id uuid,
  funding_reference text, pool_entry_id uuid, created_at timestamptz DEFAULT now(),
  remaining_amount numeric GENERATED ALWAYS AS (COALESCE(allocated_amount, 0) - COALESCE(paid_out_amount, 0)) STORED,
  notes text, updated_at timestamptz);
CREATE UNIQUE INDEX idx_alfa_one_live_per_request_source ON public.agent_landlord_float_allocations (rent_request_id, source)
  WHERE status = ANY (ARRAY['open','partially_paid']);
CREATE TABLE public.agent_float_funding (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL,
  amount numeric NOT NULL, funded_by uuid, notes text, status text DEFAULT 'active', rent_request_id uuid);
CREATE UNIQUE INDEX idx_agent_float_funding_one_per_request ON public.agent_float_funding (rent_request_id)
  WHERE rent_request_id IS NOT NULL AND status = 'active';
CREATE TABLE public.partner_float_agent_notices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), commitment_id uuid NOT NULL,
  topup_id uuid, partner_id uuid NOT NULL, agent_id uuid NOT NULL, landlord_id uuid, landlord_name text,
  amount numeric NOT NULL, tenant_count int, rent_request_ids uuid[], status text DEFAULT 'pending');
CREATE UNIQUE INDEX idx_pfan_unique_scope ON public.partner_float_agent_notices
  (COALESCE(topup_id, commitment_id), agent_id, COALESCE(landlord_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE public.partner_float_landlord_notices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), commitment_id uuid NOT NULL,
  topup_id uuid, partner_id uuid NOT NULL, agent_id uuid NOT NULL, agent_name text, landlord_id uuid, landlord_name text,
  landlord_phone text, amount numeric NOT NULL, tenant_count int, tenant_first_names text[], rent_request_ids uuid[],
  status text DEFAULT 'pending');
CREATE UNIQUE INDEX idx_pfln_unique_scope ON public.partner_float_landlord_notices
  (COALESCE(topup_id, commitment_id), agent_id, COALESCE(landlord_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE public.landlord_pool_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_table text, source_id uuid,
  status text, in_pool numeric);
CREATE TABLE public.landlord_float_receivables (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), commitment_id uuid, status text);
CREATE TABLE public.system_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, user_id uuid,
  related_entity_type text, related_entity_id uuid, description text, metadata jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE public.audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action_type text, table_name text,
  record_id text, action text, reason text, metadata jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE public.t_psm_audit (id bigserial PRIMARY KEY, actor uuid, partner uuid, action text, entity_type text,
  entity_id uuid, metadata jsonb, at timestamptz DEFAULT clock_timestamp());

-- ---------- simplified helpers ----------
CREATE FUNCTION public.psm_audit(p_actor uuid, p_partner uuid, p_action text, p_entity_type text, p_entity_id uuid, p_metadata jsonb)
RETURNS void LANGUAGE sql AS $$ INSERT INTO public.t_psm_audit (actor, partner, action, entity_type, entity_id, metadata)
  VALUES (p_actor, p_partner, p_action, p_entity_type, p_entity_id, p_metadata) $$;
CREATE FUNCTION public.psm_is_partner(p_user uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT EXISTS (SELECT 1 FROM public.t_partners WHERE user_id = p_user) $$;
CREATE FUNCTION public.funder_has_signed_agreement(p_user_id uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT EXISTS (SELECT 1 FROM public.t_partners WHERE user_id = p_user_id AND signed) $$;
CREATE FUNCTION public._pipeline_switch_on(p_key text) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT COALESCE((SELECT is_on FROM public.pipeline_switches WHERE key = p_key), false) $$;
CREATE FUNCTION public.partner_rate_now(p_partner uuid) RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE v numeric; BEGIN SELECT rate INTO v FROM public.t_partners WHERE user_id = p_partner;
  IF v IS NULL THEN RAISE EXCEPTION 'PARTNER_RATE_UNAVAILABLE'; END IF; RETURN v; END $$;
CREATE FUNCTION public.psm_contract_term_months() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 12 $$;
CREATE FUNCTION public._partner_commitment_follow_rate(p_commitment_id uuid, p_rate numeric) RETURNS void LANGUAGE sql AS $$
  UPDATE public.partner_self_commitments SET monthly_rate = p_rate WHERE id = p_commitment_id;
  UPDATE public.partner_self_funding_lines SET monthly_rate = p_rate WHERE commitment_id = p_commitment_id $$;
CREATE TABLE public.t_booked (rent_request_id uuid, partner uuid);
CREATE FUNCTION public.psm_plan_booked_for_other(p_rent_request_id uuid, p_partner uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT EXISTS (SELECT 1 FROM public.t_booked WHERE rent_request_id = p_rent_request_id AND partner <> p_partner) $$;
CREATE FUNCTION public.staff_mfa_ok() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION public.psm_is_topup_reviewer(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(current_setting('psm.owner_release', true), '') = 'on' $$;
CREATE FUNCTION public.funder_support_capacity(p_user_id uuid) RETURNS numeric LANGUAGE sql STABLE AS
  $$ SELECT public.funder_float_available(p_user_id) $$;
CREATE FUNCTION public.landlord_pool_reserve(p_portfolio uuid, p_x uuid, p_caller text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION public.landlord_pool_reserve_increment(a uuid, b text, c numeric, d text, e uuid, f text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.landlord_pool_deploy(a uuid, b numeric, c text, d uuid, e uuid, f text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION public.recognise_funding_treasury(p_rent_request_id uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"status":"skipped"}'::jsonb $$;
CREATE FUNCTION public._funder_direct_release_note(a uuid, b uuid, c uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
-- fee: one ledger pair per commitment, key ssfee-<commitment>, like production
CREATE FUNCTION public.self_support_pay_proxy_fee(p_commitment_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_fee numeric;
BEGIN
  -- like production: rent-plan lines and supported houses
  SELECT COALESCE(SUM(fee),0) INTO v_fee FROM (
    SELECT proxy_fee AS fee FROM public.partner_self_funding_lines
     WHERE commitment_id = p_commitment_id AND proxy_fee > 0 AND proxy_fee_status = 'pending'
    UNION ALL
    SELECT proxy_fee FROM public.partner_supported_houses
     WHERE commitment_id = p_commitment_id AND proxy_fee > 0 AND proxy_fee_status = 'pending') x;
  IF v_fee <= 0 THEN RETURN '{"status":"skipped"}'; END IF;
  UPDATE public.partner_supported_houses SET proxy_fee_status = 'paid'
   WHERE commitment_id = p_commitment_id AND proxy_fee > 0 AND proxy_fee_status = 'pending';
  PERFORM public.create_ledger_transaction(jsonb_build_array(jsonb_build_object('amount', v_fee, 'direction','cash_out',
     'category','agent_commission_earned','ledger_scope','platform','source_table','partner_self_commitments')),
     'ssfee-' || p_commitment_id::text);
  UPDATE public.partner_self_funding_lines SET proxy_fee_status = 'paid'
   WHERE commitment_id = p_commitment_id AND proxy_fee > 0 AND proxy_fee_status = 'pending';
  RETURN jsonb_build_object('status','paid','fee',v_fee);
END $$;

CREATE FUNCTION public.self_support_gross(p_rent numeric) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_rent IS NULL OR p_rent <= 0 THEN p_rent
           WHEN NOT COALESCE(p.enabled, false) OR COALESCE(p.rate, 0) = 0 THEN p_rent
           ELSE ceil(p_rent * (1 + p.rate) / p.round_to) * p.round_to
         END
    FROM (SELECT 1) one
    LEFT JOIN public.self_support_fee_policy p ON p.id $$;

CREATE FUNCTION public.psm_assert_no_foreign_booking(p_partner uuid, p_rent_request_ids uuid[]) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM unnest(COALESCE(p_rent_request_ids, ARRAY[]::uuid[])) AS x
   WHERE public.psm_plan_booked_for_other(x, p_partner);
  IF v_n > 0 THEN RAISE EXCEPTION 'PLAN_BOOKED_BY_OTHER_PARTNER'; END IF;
END $$;

CREATE TABLE public.promissory_note_plan_intents (note_id uuid, rent_request_id uuid, status text);
CREATE TABLE public.promissory_notes (id uuid, partner_user_id uuid);

-- live funder_pending_hold (before co-support) and funder_float_available
CREATE FUNCTION public.funder_pending_hold(p_user_id uuid) RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public' AS $function$
BEGIN
  RETURN (
  SELECT COALESCE(SUM(f.amount), 0)::numeric
  FROM public.funder_pending_portfolios f
  WHERE f.funder_id = p_user_id
    AND f.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
       WHERE g.ledger_scope = 'wallet'
         AND g.direction = 'cash_out'
         AND g.category IN ('partner_funding','supporter_rent_fund','portfolio_topup')
         AND (
              g.idempotency_key = 'portfolio-funding-' || f.portfolio_id::text
           OR (g.source_table = 'investor_portfolios' AND g.source_id = f.portfolio_id)
           OR (f.commitment_id IS NOT NULL
               AND g.source_table = 'partner_self_funding_lines'
               AND g.source_id IN (
                    SELECT l.id FROM public.partner_self_funding_lines l
                     WHERE l.commitment_id = f.commitment_id))
         )
    ));
END;
$function$;
CREATE FUNCTION public.funder_float_available(p_user_id uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public' AS $function$
  SELECT GREATEST(0, public.get_user_float_available_balance(p_user_id) - GREATEST(0, public.funder_pending_hold(p_user_id)));
$function$;
