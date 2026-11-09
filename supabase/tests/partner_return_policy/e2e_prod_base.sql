-- Phase 6 e2e BASELINE: production's own text of the creation/payout paths the suite drives, for a database that
-- never had Phase 1/2/4 applied (mode 'base'). LOCAL THROWAWAY CLUSTER ONLY.
-- Verbatim pg_get_functiondef read with SELECT from byrzshwlentqvktcksem on 2026-11-07:
--   create_pending_portfolio(uuid,numeric,integer,numeric,text,text,text)  md5 10094e3dafd79c145070c81c1f3ea5ec
--   funder_create_pending_portfolio(numeric,uuid,integer)                  md5 6b938de2bbfe96a4f97d82672dbfac7d
--   post_rent_facilitation_reward(uuid,integer,uuid,text)                   md5 3d4487b17add84f9cb1ab32d2ee34927
--   agent_create_promissory_note(jsonb,uuid[])                              md5 3fc2b24b3cfc9b37dabaa326d3771a97
--   psm_queue_promissory_pledge_notice(uuid)                                (production text, read 2026-11-07)
-- hr_pay_post_staff_reinvestment comes from tests/partner_return_policy/prod_hr_pay_post_staff_reinvestment.sql
-- (md5 ed4cc123465f945d282e109f8770a22b). Keep this file LF-only.
SET client_min_messages = warning;
DROP FUNCTION IF EXISTS public.create_pending_portfolio(uuid,numeric,integer,numeric,text,text,text);
DROP FUNCTION IF EXISTS public.funder_create_pending_portfolio(numeric,uuid,integer);
DROP FUNCTION IF EXISTS public.post_rent_facilitation_reward(uuid,integer,uuid,text);
DROP FUNCTION IF EXISTS public.agent_create_promissory_note(jsonb,uuid[]);
DROP FUNCTION IF EXISTS public.psm_queue_promissory_pledge_notice(uuid);

CREATE OR REPLACE FUNCTION public.create_pending_portfolio(p_partner_id uuid, p_amount numeric, p_duration_months integer, p_roi_percentage numeric, p_roi_mode text, p_nickname text, p_raw_token text)
 RETURNS TABLE(portfolio_id uuid, portfolio_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_partner_email text;
  v_partner_phone text;
  v_ref text;
  v_pid uuid;
  v_pin text;
  v_payout_day int;
  v_next_roi date;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING HINT = 'not_signed_in';
  END IF;

  IF NOT public.is_partner_ops(v_caller) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING HINT = 'only_partner_ops_can_create_portfolios';
  END IF;

  -- Promissory-linked partners are self-support only.
  PERFORM public.assert_no_promissory_self_support(p_partner_id, 'create_pending_portfolio');

  IF p_amount IS NULL OR p_amount < 20000 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING HINT = 'amount_below_minimum';
  END IF;

  IF p_duration_months IS NULL OR p_duration_months < 1 OR p_duration_months > 60 THEN
    RAISE EXCEPTION 'INVALID_DURATION' USING HINT = 'duration_out_of_range';
  END IF;

  IF p_roi_percentage IS NULL OR p_roi_percentage <= 0 OR p_roi_percentage > 100 THEN
    RAISE EXCEPTION 'INVALID_ROI' USING HINT = 'roi_out_of_range';
  END IF;

  IF p_roi_mode NOT IN ('monthly_payout','monthly_compounding') THEN
    RAISE EXCEPTION 'INVALID_MODE' USING HINT = 'roi_mode_invalid';
  END IF;

  IF p_raw_token IS NULL OR length(p_raw_token) < 32 THEN
    RAISE EXCEPTION 'INVALID_TOKEN' USING HINT = 'token_too_short';
  END IF;

  SELECT email, phone INTO v_partner_email, v_partner_phone
  FROM public.profiles WHERE id = p_partner_id;

  IF v_partner_email IS NULL AND v_partner_phone IS NULL THEN
    RAISE EXCEPTION 'PARTNER_MISSING_CONTACT' USING HINT = 'no_email_or_phone';
  END IF;

  v_ref := 'WIP' ||
    to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') ||
    lpad((floor(random()*9000)+1000)::int::text, 4, '0');
  v_pin := lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  v_payout_day := LEAST(EXTRACT(day FROM (now() AT TIME ZONE 'UTC'))::int, 28);
  v_next_roi := ((now() AT TIME ZONE 'UTC')::date + INTERVAL '1 month')::date;

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount,
    roi_percentage, roi_mode, duration_months, payout_day,
    next_roi_date, status, portfolio_pin, activation_token, auto_reinvest
  )
  VALUES (
    p_partner_id, p_partner_id, v_ref, p_amount,
    p_roi_percentage, p_roi_mode, p_duration_months, v_payout_day,
    v_next_roi, 'awaiting_partner_details', v_pin, gen_random_uuid(), false
  )
  RETURNING id INTO v_pid;

  INSERT INTO public.portfolio_completion_tokens (
    portfolio_id, partner_id, token_hash,
    email_snapshot, phone_snapshot, created_by
  )
  VALUES (
    v_pid, p_partner_id, encode(extensions.digest(p_raw_token, 'sha256'), 'hex'),
    v_partner_email, v_partner_phone, v_caller
  );

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    v_caller, 'create_pending_portfolio', 'investor_portfolios', v_pid,
    jsonb_build_object(
      'partner_id', p_partner_id,
      'amount', p_amount,
      'roi_percentage', p_roi_percentage,
      'duration_months', p_duration_months,
      'roi_mode', p_roi_mode,
      'nickname', p_nickname,
      'payout_day', v_payout_day,
      'next_roi_date', v_next_roi,
      'reason', 'partner_completion_invite_sent'
    )
  );

  RETURN QUERY SELECT v_pid, v_ref;
END;
$function$;

CREATE OR REPLACE FUNCTION public.funder_create_pending_portfolio(p_amount numeric, p_summary_id uuid DEFAULT NULL::uuid, p_term_months integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_available numeric;
  v_reserved numeric;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  IF NOT public.funder_has_signed_agreement(v_uid) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'Sign your partner agreement before creating a portfolio.';
  END IF;

  PERFORM public.assert_no_promissory_self_support(v_uid, 'funder_create_pending_portfolio');

  IF COALESCE(p_amount,0) < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('funder-pending-' || v_uid::text));

  -- Operational float, already net of portfolios awaiting approval.
  v_available := public.funder_float_capacity(v_uid);
  v_reserved  := GREATEST(0, public.funder_pending_hold(v_uid));

  IF p_amount > v_available THEN
    RAISE EXCEPTION 'Your operational float has UGX % available (UGX % already awaiting approval).',
      round(GREATEST(v_available, 0)), round(v_reserved)
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_uid ORDER BY created_at LIMIT 1;

  v_code := 'WPF-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_uid, COALESCE(v_agent, v_uid), v_code, p_amount,
    GREATEST(1, LEAST(COALESCE(p_term_months,12), 60)),
    15, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, summary_id, term_months
  ) VALUES (
    v_portfolio_id, v_uid, p_amount, 'rent_pool', p_summary_id,
    GREATEST(1, LEAST(COALESCE(p_term_months,12), 60))
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_uid, 'funder_pending_portfolio_created', 'investor_portfolios', v_portfolio_id,
    jsonb_build_object('reason','funder_created_pending_portfolio_awaiting_ops','amount',p_amount,
                       'funding_source','operational_float',
                       'float_usage','portfolio_funding',
                       'float_available_before', v_available));

  RETURN jsonb_build_object(
    'portfolio_id', v_portfolio_id,
    'portfolio_code', v_code,
    'status', 'pending_ops_approval',
    'amount', p_amount,
    'funding_source', 'operational_float',
    'available_balance', public.funder_float_capacity(v_uid)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_rent_facilitation_reward(p_rent_request_id uuid, p_payment_number integer, p_reinvest_portfolio_id uuid DEFAULT NULL::uuid, p_wallet_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  rr record;
  pf record;
  v_now timestamptz := now();
  v_amount numeric;
  v_payment_id uuid;
  v_group uuid;
  v_key text := 'rent-reward:' || p_rent_request_id::text || ':' || p_payment_number::text;
  v_rent_txt text;
  v_new_principal numeric;
BEGIN
  -- One reward at a time per rent request.
  SELECT id, supporter_id, rent_amount, funded_at, status, next_roi_due_date, coalesce(total_roi_paid, 0) total_roi_paid,
         coalesce(roi_payments_count, 0) roi_payments_count
    INTO rr FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RENT_REWARD_NO_REQUEST: rent request % not found', p_rent_request_id USING ERRCODE = '22023'; END IF;

  -- Already done (by this or an earlier run): report, change nothing.
  IF p_payment_number <= rr.roi_payments_count THEN
    RETURN jsonb_build_object('status', 'already_posted', 'payment_number', p_payment_number);
  END IF;
  IF p_payment_number <> rr.roi_payments_count + 1 THEN
    RAISE EXCEPTION 'RENT_REWARD_STALE: expected payment % for rent request %, got %', rr.roi_payments_count + 1, p_rent_request_id, p_payment_number
      USING ERRCODE = '22023';
  END IF;
  -- A row for this payment number with the schedule not advanced: recorded by the old flow, posting unknown.
  -- Never post on top of it automatically; it appears in rent_reward_posting_gaps() for a CFO decision.
  IF EXISTS (SELECT 1 FROM public.supporter_roi_payments s WHERE s.rent_request_id = p_rent_request_id AND s.payment_number = p_payment_number) THEN
    RETURN jsonb_build_object('status', 'recorded_without_schedule', 'payment_number', p_payment_number);
  END IF;

  IF rr.supporter_id IS NULL OR rr.funded_at IS NULL OR rr.status NOT IN ('funded', 'disbursed', 'completed') THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;
  IF (rr.next_roi_due_date IS NOT NULL AND rr.next_roi_due_date > v_now)
     OR (rr.next_roi_due_date IS NULL AND rr.funded_at + interval '30 days' > v_now) THEN
    RETURN jsonb_build_object('status', 'not_due', 'next_due', coalesce(rr.next_roi_due_date, rr.funded_at + interval '30 days'));
  END IF;

  v_amount := round(rr.rent_amount * 0.15);
  IF v_amount <= 0 THEN RAISE EXCEPTION 'RENT_REWARD_AMOUNT: non-positive reward' USING ERRCODE = '22023'; END IF;
  v_rent_txt := to_char(rr.rent_amount, 'FM999,999,999,990');

  IF p_reinvest_portfolio_id IS NOT NULL THEN
    SELECT id, investor_id, status, investment_amount INTO pf FROM public.investor_portfolios WHERE id = p_reinvest_portfolio_id FOR UPDATE;
    IF NOT FOUND OR pf.investor_id IS DISTINCT FROM rr.supporter_id OR pf.status <> 'active' THEN
      RAISE EXCEPTION 'RENT_REWARD_REINVEST_TARGET_UNAVAILABLE: portfolio % is not an active portfolio of the supporter', p_reinvest_portfolio_id
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.supporter_roi_payments (rent_request_id, supporter_id, rent_amount, roi_amount, payment_number, due_date, paid_at, status)
    VALUES (rr.id, rr.supporter_id, rr.rent_amount, v_amount, p_payment_number, v_now, v_now, 'reinvested')
    RETURNING id INTO v_payment_id;
    -- Raises PORTFOLIO_ON_HOLD for a held portfolio; the whole reward then rolls back.
    UPDATE public.investor_portfolios SET investment_amount = investment_amount + v_amount WHERE id = pf.id
    RETURNING investment_amount INTO v_new_principal;
    v_group := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_out', 'amount', v_amount, 'category', 'roi_expense',
        'ledger_scope', 'platform', 'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        'description', format('ROI payout #%s auto-reinvested into portfolio', p_payment_number), 'currency', 'UGX', 'transaction_date', v_now),
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_in', 'amount', v_amount, 'category', 'roi_reinvestment',
        'ledger_scope', 'platform', 'source_table', 'investor_portfolios', 'source_id', pf.id, 'linked_party', 'platform',
        'description', format('Auto-reinvested ROI #%s (%s) into portfolio', p_payment_number, to_char(v_amount, 'FM999,999,999,990')),
        'currency', 'UGX', 'transaction_date', v_now)), v_key, false);
  ELSE
    INSERT INTO public.supporter_roi_payments (rent_request_id, supporter_id, rent_amount, roi_amount, payment_number, due_date, paid_at, status)
    VALUES (rr.id, rr.supporter_id, rr.rent_amount, v_amount, p_payment_number, v_now, v_now, 'paid')
    RETURNING id INTO v_payment_id;
    v_group := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_out', 'amount', v_amount, 'category', 'roi_expense',
        'ledger_scope', 'platform', 'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        'description', format('Platform ROI payout #%s to supporter for rent facilitation of UGX %s', p_payment_number, v_rent_txt),
        'currency', 'UGX', 'transaction_date', v_now),
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_in', 'amount', v_amount, 'category', 'roi_wallet_credit',
        'ledger_scope', 'wallet', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        'description', coalesce(nullif(btrim(p_wallet_description), ''),
                                format('15%% monthly reward (payment #%s) on rent facilitation of UGX %s', p_payment_number, v_rent_txt)),
        'currency', 'UGX', 'transaction_date', v_now)), v_key, false);
  END IF;

  UPDATE public.rent_requests
     SET next_roi_due_date = v_now + interval '30 days',
         total_roi_paid = rr.total_roi_paid + v_amount,
         roi_payments_count = p_payment_number
   WHERE id = rr.id;

  RETURN jsonb_build_object('status', 'posted', 'mode', CASE WHEN p_reinvest_portfolio_id IS NULL THEN 'wallet' ELSE 'reinvest' END,
    'payment_id', v_payment_id, 'payment_number', p_payment_number, 'amount', v_amount, 'transaction_group_id', v_group,
    'portfolio_id', p_reinvest_portfolio_id, 'previous_principal', CASE WHEN p_reinvest_portfolio_id IS NULL THEN NULL ELSE v_new_principal - v_amount END,
    'new_principal', v_new_principal);
END
$function$;

CREATE OR REPLACE FUNCTION public.agent_create_promissory_note(p_payload jsonb, p_rent_request_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[] := COALESCE(p_rent_request_ids, '{}'::uuid[]);
  v_amount numeric := COALESCE((p_payload->>'amount')::numeric, 0);
  v_name text := btrim(COALESCE(p_payload->>'partner_name', ''));
  v_whatsapp text := btrim(COALESCE(p_payload->>'whatsapp_number', ''));
  v_email text := lower(btrim(COALESCE(p_payload->>'email', '')));
  v_type text := COALESCE(NULLIF(btrim(p_payload->>'contribution_type'), ''), 'once_off');
  v_support_mode text := COALESCE(NULLIF(btrim(p_payload->>'support_mode'), ''), 'existing_support');
  v_recorded_on date := COALESCE(NULLIF(btrim(COALESCE(p_payload->>'recorded_on','')), '')::date, CURRENT_DATE);
  v_fulfil_on date := NULLIF(btrim(COALESCE(p_payload->>'fulfilment_due_on','')), '')::date;
  v_note public.promissory_notes;
  v_valid integer := 0;
  v_sum numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.is_ops_role(v_uid)
    OR EXISTS (
      SELECT 1
      FROM public.partner_lead_assignments pla
      WHERE pla.agent_id = v_uid
        AND pla.detached_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'Not authorised to create promissory notes' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) < 3 THEN RAISE EXCEPTION 'Partner name is required' USING ERRCODE = '22023'; END IF;
  IF length(regexp_replace(v_whatsapp, '\D', '', 'g')) < 9 THEN RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023'; END IF;
  -- Email is optional; validate only when one was supplied.
  IF v_email <> '' AND (length(v_email) > 255 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'EMAIL_INVALID: enter a valid email address or leave it blank.' USING ERRCODE = '22023';
  END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Promised amount must be greater than zero' USING ERRCODE = '22023'; END IF;
  IF v_fulfil_on IS NOT NULL AND v_fulfil_on < v_recorded_on THEN
    RAISE EXCEPTION 'FULFILMENT_BEFORE_RECORDED: the fulfilment date cannot be earlier than the recording date.' USING ERRCODE = '22023';
  END IF;
  IF v_support_mode NOT IN ('self_support','existing_support') THEN
    RAISE EXCEPTION 'INVALID_SUPPORT_MODE' USING ERRCODE = '22023';
  END IF;
  IF v_support_mode = 'self_support' AND COALESCE(array_length(v_ids,1),0) = 0 THEN
    RAISE EXCEPTION 'SELF_SUPPORT_PLANS_REQUIRED: select at least one tenant rent plan for self support.' USING ERRCODE = '23514';
  END IF;
  IF v_support_mode = 'existing_support' AND COALESCE(array_length(v_ids,1),0) > 0 THEN
    RAISE EXCEPTION 'EXISTING_SUPPORT_HAS_PLANS: tenant plan selections belong to self support.' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.promissory_notes (
    agent_id, partner_name, whatsapp_number, phone_number, email,
    amount, contribution_type, deduction_day, next_deduction_date, support_mode,
    recorded_on, fulfilment_due_on
  ) VALUES (
    v_uid, v_name, v_whatsapp,
    NULLIF(btrim(COALESCE(p_payload->>'phone_number','')), ''),
    NULLIF(v_email, ''),
    v_amount,
    CASE WHEN v_type = 'monthly' THEN 'monthly' ELSE 'once_off' END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'deduction_day','')::integer END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'next_deduction_date','')::date END,
    v_support_mode,
    v_recorded_on, v_fulfil_on
  ) RETURNING * INTO v_note;

  IF COALESCE(array_length(v_ids,1),0) > 0 THEN
    INSERT INTO public.promissory_note_plan_intents (note_id, rent_request_id, agent_id, amount)
    SELECT v_note.id, p.rent_request_id, v_uid, p.funding_amount
    FROM public.v_partner_self_fundable_plans p
    WHERE p.rent_request_id = ANY(v_ids)
      AND p.held_by IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_plan_intents i
        WHERE i.rent_request_id = p.rent_request_id AND i.status = 'reserved'
      );

    SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_valid, v_sum
    FROM public.promissory_note_plan_intents
    WHERE note_id = v_note.id AND status = 'reserved';

    IF v_valid <> array_length(v_ids,1) THEN
      RAISE EXCEPTION 'PLANS_UNAVAILABLE: some selected rent plans are no longer ready to fund. Refresh and try again.' USING ERRCODE = '23514';
    END IF;
    IF v_sum > v_amount THEN
      RAISE EXCEPTION 'PLANS_EXCEED_AMOUNT: attached plans total more than the promised amount.' USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM public.psm_queue_promissory_pledge_notice(v_note.id);

  RETURN jsonb_build_object(
    'note', to_jsonb(v_note), 'support_mode', v_support_mode,
    'attached_count', v_valid, 'attached_amount', v_sum,
    'monthly_return', round(v_amount * 0.15), 'annual_return', round(v_amount * 0.15 * 12)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.psm_queue_promissory_pledge_notice(p_note_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_note public.promissory_notes;
  v_tenants jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_amount numeric := 0;
BEGIN
  SELECT * INTO v_note FROM public.promissory_notes WHERE id = p_note_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tenant_name', COALESCE(v.tenant_full_name, 'Tenant'),
           'tenant_location', COALESCE(v.tenant_location, v.request_city, ''),
           'principal', i.amount
         ) ORDER BY i.amount DESC), '[]'::jsonb),
         COUNT(*), COALESCE(SUM(i.amount), 0)
  INTO v_tenants, v_count, v_amount
  FROM public.promissory_note_plan_intents i
  LEFT JOIN public.v_partner_self_fundable_plans v ON v.rent_request_id = i.rent_request_id
  WHERE i.note_id = p_note_id AND i.status = 'reserved';

  INSERT INTO public.promissory_note_pledge_notices (
    note_id, partner_name, phone, email, amount,
    attached_count, attached_amount, monthly_return, annual_return, tenants
  ) VALUES (
    p_note_id, v_note.partner_name,
    COALESCE(NULLIF(btrim(v_note.whatsapp_number),''), NULLIF(btrim(v_note.phone_number),'')),
    NULLIF(btrim(v_note.email),''),
    v_note.amount, v_count, v_amount,
    round(v_note.amount * 0.15), round(v_note.amount * 0.15 * 12),
    v_tenants
  )
  ON CONFLICT (note_id) DO NOTHING;
END;
$function$;
-- Production ACLs (all four granted to authenticated + service_role in production; the reward and payroll to service_role).
REVOKE ALL ON FUNCTION public.create_pending_portfolio(uuid,numeric,integer,numeric,text,text,text), public.funder_create_pending_portfolio(numeric,uuid,integer),
  public.agent_create_promissory_note(jsonb,uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pending_portfolio(uuid,numeric,integer,numeric,text,text,text), public.funder_create_pending_portfolio(numeric,uuid,integer),
  public.agent_create_promissory_note(jsonb,uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.post_rent_facilitation_reward(uuid,integer,uuid,text), public.psm_queue_promissory_pledge_notice(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_rent_facilitation_reward(uuid,integer,uuid,text) TO service_role;
SELECT 'e2e prod base ready';
