-- Self-support: the partner earns for the full 12-month contract term.
--
-- Decisions (2026-10-26, confirmed by the product owner):
--   * The rent plan must not affect the partner's portfolio. When a plan is
--     marked completed the partner's line keeps earning until the contract
--     term ends; only the platform's own books care that the plan completed.
--   * The term is no longer chosen by the screen (it was hard-coded to 1
--     month). The server owns one constant: psm_contract_term_months() = 12,
--     matching the 12-month partner agreement.
--   * The portfolio goes inactive (status 'matured') when the contract term
--     ends. The existing pre-maturity notices (auto-maturity-notice) already
--     tell the partner; redemption/renewal stays on the existing flows.
--   * A rent plan that ENDS EARLY (cancelled, rejected, deleted by the agent)
--     still stops the line from earning, so a plan that never ran cannot pay
--     returns for twelve months.
--   * When partner money is funded onto a tenant, the landlord is told by SMS
--     (queued here, sent by the notify-partner-float-landlords edge function),
--     the same way the agent is told.
--   * Empty-house money never reaches an agent (unchanged; the house
--     activation migration is parked in docs/pending-changes/).
--
-- Not changed on purpose: commitments already approved with a 1-month term
-- (legacy). Only commitments still pending approval are moved to 12 months.
-- Written from the LIVE production definitions (2026-10-26); the migrations
-- folder does not faithfully reflect production.

-- 1. One place that says how long a self-support contract runs ---------------
CREATE OR REPLACE FUNCTION public.psm_contract_term_months()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $$ SELECT 12 $$;

-- 2. Ops-only record of a plan's end (never shown to the partner) ------------
ALTER TABLE public.partner_self_funding_lines
  ADD COLUMN IF NOT EXISTS plan_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS end_reason text;

-- 3a. Tenant support: the commitment term is the contract term
CREATE OR REPLACE FUNCTION public.psm_confirm_commitment_for(p_partner uuid, p_rent_request_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_actor uuid DEFAULT NULL::uuid, p_promissory_note_id uuid DEFAULT NULL::uuid, p_funding_mode text DEFAULT 'float'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key text := COALESCE(NULLIF(p_idempotency_key,''), 'psm-' || p_partner::text || '-' || md5(array_to_string(p_rent_request_ids,',')));
  v_existing public.partner_self_commitments%ROWTYPE;
  v_commitment_id uuid;
  v_total numeric;
  v_count integer;
  v_min numeric;
  v_available numeric;
  v_reserved numeric;
  v_capacity numeric;
  v_mode text := COALESCE(NULLIF(p_funding_mode,''), 'float');
  v_rate numeric := 15;
  -- The screen no longer decides the term. Promissory-note commitments keep
  -- their own requested term; every other self-support commitment is the
  -- contract term.
  v_term integer := CASE WHEN p_promissory_note_id IS NULL
                         THEN public.psm_contract_term_months()
                         ELSE GREATEST(1, LEAST(COALESCE(p_term_months,1), 12)) END;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_note uuid := p_promissory_note_id;
  v_actor uuid := COALESCE(p_actor, auth.uid(), p_partner);
BEGIN
  IF p_partner IS NULL THEN
    RAISE EXCEPTION 'PARTNER_REQUIRED';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids,1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;
  IF v_mode NOT IN ('withdrawable','float','receivable') THEN
    RAISE EXCEPTION 'INVALID_FUNDING_MODE';
  END IF;

  IF NOT public.funder_has_signed_agreement(p_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  IF v_note IS NULL THEN
    SELECT i.note_id INTO v_note
    FROM public.promissory_note_plan_intents i
    JOIN public.promissory_notes n ON n.id = i.note_id AND n.partner_user_id = p_partner
    WHERE i.rent_request_id = ANY(p_rent_request_ids)
      AND i.status IN ('reserved','funded')
    LIMIT 1;
  END IF;

  PERFORM public.psm_assert_no_foreign_booking(p_partner, p_rent_request_ids);

  PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || p_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
                              'committed_amount', v_existing.committed_amount,
                              'lines', v_existing.lines_count,
                              'status', v_existing.status);
  END IF;

  UPDATE public.partner_self_plan_claims
     SET status='expired', closed_at=now(), updated_at=now()
   WHERE status='held' AND expires_at <= now();

  INSERT INTO public.partner_self_plan_claims (rent_request_id, partner_id, amount, expires_at, idempotency_key)
  SELECT p.rent_request_id, p_partner, p.funding_amount, now() + interval '15 minutes', v_key
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = ANY(p_rent_request_ids)
    AND (p.held_by IS NULL OR p.held_by = p_partner)
  ON CONFLICT (rent_request_id) WHERE status IN ('held','confirmed') DO NOTHING;

  UPDATE public.partner_self_plan_claims
     SET expires_at = now() + interval '15 minutes', updated_at = now()
   WHERE partner_id = p_partner AND status = 'held' AND rent_request_id = ANY(p_rent_request_ids);

  SELECT COUNT(*), COALESCE(SUM(amount),0), COALESCE(MIN(amount),0)
  INTO v_count, v_total, v_min
  FROM public.partner_self_plan_claims
  WHERE partner_id = p_partner AND status = 'held' AND expires_at > now()
    AND rent_request_id = ANY(p_rent_request_ids);

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_rent_request_ids,1),0) THEN
    RAISE EXCEPTION 'Some selections are no longer available. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_min < 50000 THEN
    RAISE EXCEPTION 'Each plan funded must be at least UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(p_partner);
  v_reserved := public.funder_pending_hold(p_partner);

  IF v_mode = 'withdrawable' THEN
    IF v_total > v_available THEN
      RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: plans total UGX %, partner has UGX % of operational float available (UGX % already awaiting approval).',
        round(v_total), round(GREATEST(v_available,0)), round(v_reserved)
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_mode = 'float' THEN
    v_capacity := public.funder_float_available(p_partner);
    IF v_total > v_capacity THEN
      RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: plans total UGX %, partner holds UGX % of operational float.',
        round(v_total), round(GREATEST(v_capacity,0))
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- 'receivable': no capacity requirement; the promise is recorded by the caller.

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status, promissory_note_id
  ) VALUES (
    p_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval', v_note
  ) RETURNING id INTO v_commitment_id;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months
  )
  SELECT v_commitment_id, p_partner, c.rent_request_id, c.amount, v_rate, v_term
  FROM public.partner_self_plan_claims c
  WHERE c.partner_id = p_partner AND c.status='held' AND c.rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.partner_self_plan_claims
     SET status='confirmed', confirmed_at=now(), commitment_id=v_commitment_id, updated_at=now()
   WHERE partner_id = p_partner AND status='held' AND rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.rent_requests rr
     SET self_funding_partner_id = p_partner,
         self_funding_line_id = l.id,
         updated_at = now()
  FROM public.partner_self_funding_lines l
  WHERE l.commitment_id = v_commitment_id AND rr.id = l.rent_request_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = p_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSP-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    p_partner, COALESCE(v_agent, p_partner), v_code, v_total, v_term,
    v_rate, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months, promissory_note_id
  ) VALUES (v_portfolio_id, p_partner, v_total, 'self_managed', v_commitment_id, v_term, v_note);

  PERFORM public.psm_audit(v_actor, p_partner, 'commitment_pending_ops_approval', 'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'lines', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'available_before', v_available,
                       'promissory_note_id', v_note,
                       'funding_mode', v_mode,
                       'idempotency_key', v_key));

  IF v_note IS NOT NULL THEN
    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('promissory.self_support.portfolio_created', p_partner, 'promissory_notes', v_note,
              'Promissory partner capital deployed as a self-support portfolio',
              jsonb_build_object('portfolio_id', v_portfolio_id, 'commitment_id', v_commitment_id,
                                 'amount', v_total, 'lines', v_count, 'actor_id', v_actor,
                                 'source', 'self_managed'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'committed_amount', v_total, 'lines', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'portfolio_id', v_portfolio_id,
    'promissory_note_id', v_note,
    'funding_mode', v_mode,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(p_partner)
  );
END;
$function$;

-- 3b. House support (both overloads): same contract term
CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric := 15;
  v_key text;
  v_total numeric := 0;
  v_count integer := 0;
  v_available numeric;
  v_commitment_id uuid;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_existing public.partner_self_commitments%ROWTYPE;
BEGIN
  IF v_partner IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED';
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key,''),
    'psh-' || v_partner::text || '-' || md5(array_to_string(p_house_ids,',')));

  IF NOT public.funder_has_signed_agreement(v_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psh-commit-' || v_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
      'committed_amount', v_existing.committed_amount, 'houses', v_existing.lines_count,
      'status', v_existing.status);
  END IF;

  CREATE TEMP TABLE _psh_pick ON COMMIT DROP AS
  SELECT h.id AS house_id, h.monthly_rent::numeric AS principal,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(principal),0) INTO v_count, v_total FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % of operational float available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    v_rate, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, v_rate, v_term,
         'pending', p.landlord_id, p.agent_id,
         jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key)
  FROM _psh_pick p;

  PERFORM public.psm_audit(v_partner, v_partner, 'house_support_pending_ops_approval',
    'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'houses', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'funding_tag','self_support_operational_house',
                       'idempotency_key', v_key));

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('portfolio_topup', v_partner, 'investor_portfolios', v_portfolio_id,
            'Partner submitted a verified-house self-support portfolio',
            jsonb_build_object('commitment_id', v_commitment_id, 'amount', v_total,
                               'houses', v_count, 'source','self_managed_house'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
    'committed_amount', v_total, 'houses', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_commitment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric := 15;
  v_key text;
  v_total numeric := 0;
  v_count integer := 0;
  v_available numeric;
  v_commitment_id uuid;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_existing public.partner_self_commitments%ROWTYPE;
  v_target public.partner_self_commitments%ROWTYPE;
  v_is_topup boolean := p_commitment_id IS NOT NULL;
  v_elig jsonb;
BEGIN
  IF v_partner IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED';
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key,''),
    'psh-' || v_partner::text || '-' || COALESCE(p_commitment_id::text,'new') || '-' || md5(array_to_string(p_house_ids,',')));

  IF NOT public.funder_has_signed_agreement(v_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psh-commit-' || v_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
      'committed_amount', v_existing.committed_amount, 'houses', v_existing.lines_count,
      'status', v_existing.status);
  END IF;

  CREATE TEMP TABLE _psh_pick ON COMMIT DROP AS
  SELECT h.id AS house_id, h.monthly_rent::numeric AS principal,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(principal),0) INTO v_count, v_total FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % of operational float available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_topup THEN
    SELECT * INTO v_target FROM public.partner_self_commitments
     WHERE id = p_commitment_id AND partner_id = v_partner FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;

    -- A rent-plan portfolio can never absorb house capital: the flows differ.
    IF EXISTS (SELECT 1 FROM public.partner_self_funding_lines
                WHERE commitment_id = v_target.id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'PORTFOLIO_KIND_MISMATCH: this portfolio funds rent plans, so houses cannot be added to it.'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT MIN(portfolio_id) INTO v_portfolio_id FROM public.partner_supported_houses
     WHERE commitment_id = v_target.id AND status <> 'cancelled';
    IF v_portfolio_id IS NULL THEN
      RAISE EXCEPTION 'PORTFOLIO_KIND_MISMATCH: this portfolio does not hold houses.'
        USING ERRCODE = 'check_violation';
    END IF;

    v_elig := public.partner_self_topup_eligibility(v_target.id);
    IF NOT (v_elig->>'allow_topup')::boolean THEN
      RAISE EXCEPTION 'PSM_TOPUP_WINDOW_CLOSED: %', COALESCE(v_elig->>'block_reason','Top-up not allowed')
        USING ERRCODE = 'check_violation';
    END IF;

    v_commitment_id := v_target.id;
    SELECT MIN(metadata->>'portfolio_code') INTO v_code FROM public.partner_supported_houses
     WHERE commitment_id = v_target.id AND status <> 'cancelled';

    INSERT INTO public.partner_supported_houses (
      partner_id, house_id, commitment_id, portfolio_id, principal, monthly_rate, term_months,
      status, landlord_id, listing_agent_id, metadata
    )
    SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal,
           COALESCE(v_target.monthly_rate, v_rate), COALESCE(v_target.term_months, v_term),
           'pending', p.landlord_id, p.agent_id,
           jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key, 'topup', true)
    FROM _psh_pick p;

    UPDATE public.partner_self_commitments
       SET lines_count = COALESCE(lines_count,0) + v_count, updated_at = now()
     WHERE id = v_commitment_id;

    INSERT INTO public.funder_pending_portfolios (
      portfolio_id, funder_id, amount, source, commitment_id, term_months
    ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house_topup', v_commitment_id,
              COALESCE(v_target.term_months, v_term));

    PERFORM public.psm_audit(v_partner, v_partner, 'house_support_topup_pending_ops_approval',
      'partner_self_commitments', v_commitment_id,
      jsonb_build_object('amount', v_total, 'houses', v_count, 'portfolio_id', v_portfolio_id,
                         'idempotency_key', v_key));

    RETURN jsonb_build_object(
      'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
      'topup', true, 'committed_amount', v_total, 'houses', v_count,
      'monthly_return', round(v_total * COALESCE(v_target.monthly_rate, v_rate) / 100),
      'status', 'pending_ops_approval',
      'available_balance', public.funder_float_available(v_partner)
    );
  END IF;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    v_rate, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, v_rate, v_term,
         'pending', p.landlord_id, p.agent_id,
         jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key)
  FROM _psh_pick p;

  PERFORM public.psm_audit(v_partner, v_partner, 'house_support_pending_ops_approval',
    'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'houses', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'funding_tag','self_support_operational_house',
                       'idempotency_key', v_key));

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('portfolio_topup', v_partner, 'investor_portfolios', v_portfolio_id,
            'Partner submitted a verified-house self-support portfolio',
            jsonb_build_object('commitment_id', v_commitment_id, 'amount', v_total,
                               'houses', v_count, 'source','self_managed_house'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
    'committed_amount', v_total, 'houses', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$;

-- 3c. Term end is anchored on the contract term
CREATE OR REPLACE FUNCTION public.psm_anchor_commitment_on_first_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.partner_self_commitments c
     SET payout_anchor_at = NEW.live_at,
         payout_day       = EXTRACT(DAY FROM NEW.live_at)::smallint,
         next_payout_at   = NEW.live_at + interval '1 month',
         term_end_at      = NEW.live_at + (GREATEST(1, COALESCE(c.term_months, public.psm_contract_term_months())) || ' months')::interval,
         updated_at       = now()
   WHERE c.id = NEW.commitment_id
     AND c.payout_anchor_at IS NULL;
  RETURN NEW;
END;
$function$;

-- 3d. Top-up window reads the contract term
CREATE OR REPLACE FUNCTION public.partner_self_topup_eligibility(p_commitment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  c public.partner_self_commitments%ROWTYPE;
  v_days_remaining integer;
  v_cycles_remaining integer;
  v_cycle_start date;
  v_cycle_end date;
  v_days_in_cycle integer;
  v_days_left_in_cycle integer;
  v_allow boolean;
  v_reason text;
  v_lockout_days integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c FROM public.partner_self_commitments
   WHERE id = p_commitment_id AND partner_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'no_data_found';
  END IF;

  v_lockout_days := CASE WHEN COALESCE(c.term_months, public.psm_contract_term_months()) <= 3 THEN 5 ELSE 90 END;
  v_days_remaining   := GREATEST(0, COALESCE(c.term_end_at::date, CURRENT_DATE) - CURRENT_DATE);
  v_cycles_remaining := GREATEST(0, floor(v_days_remaining::numeric / 30)::integer);

  v_cycle_end   := COALESCE(c.next_payout_at::date, CURRENT_DATE + 30);
  v_cycle_start := (COALESCE(c.next_payout_at, now() + interval '1 month') - interval '1 month')::date;
  v_days_in_cycle      := GREATEST(1, v_cycle_end - v_cycle_start);
  v_days_left_in_cycle := GREATEST(0, v_cycle_end - CURRENT_DATE);

  IF c.status <> 'active' THEN
    v_allow := false;
    v_reason := 'This portfolio is ' || c.status || '. New capital starts a fresh monthly portfolio.';
  ELSIF c.term_end_at IS NOT NULL AND v_days_remaining <= v_lockout_days THEN
    v_allow := false;
    v_reason := 'This portfolio matures in ' || v_days_remaining
             || ' days. The final ' || v_lockout_days || ' days are reserved for returning principal, so new capital starts a fresh monthly portfolio.';
  ELSE
    v_allow := true;
    v_reason := NULL;
  END IF;

  RETURN jsonb_build_object(
    'commitment_id', c.id,
    'status', c.status,
    'committed_amount', c.committed_amount,
    'monthly_rate', c.monthly_rate,
    'term_end_at', c.term_end_at,
    'next_payout_at', c.next_payout_at,
    'days_remaining', v_days_remaining,
    'cycles_remaining', v_cycles_remaining,
    'days_in_cycle', v_days_in_cycle,
    'days_left_in_cycle', v_days_left_in_cycle,
    'allow_topup', v_allow,
    'block_reason', v_reason,
    'available_balance', public.funder_float_available(v_uid)
  );
END;
$function$;

-- 4. A rent plan's end no longer ends the partner's returns --------------------
-- Completed plan   -> only note the date (plan_closed_at); the line stays
--                     'active' and accrue_partner_self_returns keeps paying it
--                     up to the commitment's term end.
-- Cancelled / rejected / deleted-by-agent plan -> the line ends on that day
--                     (accrual stops), exactly like a completed line did before.
-- Failures are recorded instead of silently swallowed, and never block the
-- rent plan update.
CREATE OR REPLACE FUNCTION public.psm_complete_line_on_plan_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF NEW.self_funding_partner_id IS NULL THEN RETURN NEW; END IF;
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;

    IF NEW.status IN ('completed', 'fully_repaid') THEN
      UPDATE public.partner_self_funding_lines
         SET plan_closed_at = COALESCE(plan_closed_at, now()), updated_at = now()
       WHERE rent_request_id = NEW.id AND status = 'active';
      PERFORM public.psm_audit(NULL, NEW.self_funding_partner_id, 'plan_closed_line_keeps_earning',
        'rent_requests', NEW.id, jsonb_build_object('status', NEW.status));

    ELSIF NEW.status IN ('cancelled', 'deleted_by_agent', 'rejected') THEN
      UPDATE public.partner_self_funding_lines
         SET status = 'completed', completed_at = now(),
             plan_closed_at = COALESCE(plan_closed_at, now()),
             end_reason = 'plan_' || NEW.status, updated_at = now()
       WHERE rent_request_id = NEW.id AND status IN ('active', 'idle');
      PERFORM public.psm_audit(NULL, NEW.self_funding_partner_id, 'line_ended_plan_exit',
        'rent_requests', NEW.id, jsonb_build_object('status', NEW.status));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      VALUES (NEW.self_funding_partner_id, 'psm_line_close_failed', 'rent_requests', NEW.id::text,
              'Could not update the self-support line when the rent plan changed status',
              jsonb_build_object('status', NEW.status, 'error', SQLERRM, 'sqlstate', SQLSTATE));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
  RETURN NEW;
END;
$function$;

-- 5a. Landlord SMS queue (one row per agent+landlord per approval) ------------
CREATE TABLE IF NOT EXISTS public.partner_float_landlord_notices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id      uuid NOT NULL,
  topup_id           uuid,
  partner_id         uuid NOT NULL,
  agent_id           uuid NOT NULL,
  agent_name         text,
  landlord_id        uuid,
  landlord_name      text NOT NULL DEFAULT 'the landlord',
  landlord_phone     text,
  amount             numeric NOT NULL,
  tenant_count       integer NOT NULL DEFAULT 1,
  tenant_first_names text[] NOT NULL DEFAULT '{}',
  rent_request_ids   uuid[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  provider           text,
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pfln_pending
  ON public.partner_float_landlord_notices (status, created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_pfln_unique_scope
  ON public.partner_float_landlord_notices (
    COALESCE(topup_id, commitment_id), agent_id,
    COALESCE(landlord_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE public.partner_float_landlord_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_float_landlord_notices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.partner_float_landlord_notices TO authenticated;
GRANT ALL ON public.partner_float_landlord_notices TO service_role;

DROP POLICY IF EXISTS ops_read_partner_float_landlord_notices ON public.partner_float_landlord_notices;
CREATE POLICY ops_read_partner_float_landlord_notices ON public.partner_float_landlord_notices
  FOR SELECT TO authenticated
  USING ((SELECT public.psm_is_topup_reviewer((SELECT auth.uid()))));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.partner_float_landlord_notices;
CREATE POLICY mfa_required_for_staff ON public.partner_float_landlord_notices
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

-- 5b. Queue the landlord SMS inside the approval (rest of the function unchanged)
CREATE OR REPLACE FUNCTION public.psm_disburse_landlord_float(p_commitment_id uuid, p_topup_id uuid DEFAULT NULL::uuid, p_rent_request_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid;
  v_line record;
  v_agent uuid;
  v_alloc uuid;
  v_alloc_ids uuid[] := ARRAY[]::uuid[];
  v_landlord_name text;
  v_ref text;
  v_funded integer := 0;
  v_skipped integer := 0;
  v_total numeric := 0;
  v_notices integer := 0;
  v_treasury jsonb;
  v_treasury_recognised integer := 0;
  v_pool_entry uuid;          -- Landlord Float Pool
  v_pool_drawn numeric := 0;  -- Landlord Float Pool
  v_pool_pid uuid;            -- Landlord Float Pool (self-managed top-ups)
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.psm_is_topup_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT partner_id INTO v_partner FROM public.partner_self_commitments WHERE id = p_commitment_id;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'commitment_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-float-' || p_commitment_id::text));

  -- Landlord Float Pool: a self-managed top-up's new tenant lines are reserved
  -- as self-support TOP-UP entries — only once the top-up's own wallet debit
  -- (key psm-topup-<id>) exists, and only for a pool_eligible portfolio
  -- (checked inside landlord_pool_reserve_increment).
  IF p_topup_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.general_ledger g
                  WHERE g.idempotency_key = 'psm-topup-' || p_topup_id::text) THEN
    SELECT fp.portfolio_id INTO v_pool_pid FROM public.funder_pending_portfolios fp
     WHERE fp.commitment_id = p_commitment_id ORDER BY fp.created_at DESC LIMIT 1;
  END IF;

  FOR v_line IN
    SELECT l.id AS line_id,
           l.principal,
           l.rent_request_id,
           rr.status AS rr_status,
           rr.tenant_id,
           rr.landlord_id,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           ld.name AS landlord_name,
           COALESCE(ld.mobile_money_number, ld.phone) AS landlord_phone
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
     WHERE l.commitment_id = p_commitment_id
       AND (p_rent_request_ids IS NULL OR l.rent_request_id = ANY(p_rent_request_ids))
     ORDER BY l.created_at
  LOOP
    v_agent := v_line.agent_id;

    IF v_agent IS NULL THEN
      v_skipped := v_skipped + 1;
      PERFORM public.psm_audit(auth.uid(), v_partner, 'float_disbursement_skipped',
        'partner_self_funding_lines', v_line.line_id,
        jsonb_build_object('reason', 'no_agent_assigned', 'rent_request_id', v_line.rent_request_id));
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.agent_landlord_float_allocations a
       WHERE a.rent_request_id = v_line.rent_request_id
         AND a.status IN ('open','partially_paid')
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_landlord_name := COALESCE(v_line.landlord_name, 'Unknown Landlord');
    v_ref := 'PSF-' || upper(substr(replace(v_line.line_id::text, '-', ''), 1, 8));

    INSERT INTO public.agent_landlord_float_allocations (
      agent_id, tenant_id, rent_request_id, landlord_id,
      landlord_name, landlord_phone, allocated_amount, source,
      funded_by_partner_id, funding_reference
    ) VALUES (
      v_agent, v_line.tenant_id, v_line.rent_request_id, v_line.landlord_id,
      v_landlord_name, v_line.landlord_phone, v_line.principal, 'partner_self_funding',
      v_partner, v_ref
    )
    RETURNING id INTO v_alloc;

    v_alloc_ids := v_alloc_ids || v_alloc;

    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'direction','cash_out','amount', v_line.principal,
          'category','rent_disbursement','ledger_scope','platform',
          'source_table','partner_self_funding_lines','source_id', v_line.line_id,
          'reference_id', v_ref,
          'user_id', v_agent,
          'linked_party', v_partner::text,
          'description','Partner self-managed funding released to agent landlord float for ' || v_landlord_name
        ),
        jsonb_build_object(
          'direction','cash_in','amount', v_line.principal,
          'category','rent_receivable_created','ledger_scope','bridge',
          'source_table','partner_self_funding_lines','source_id', v_line.line_id,
          'reference_id', v_ref,
          'user_id', v_agent,
          'linked_party', v_partner::text,
          'description','Landlord float credited (partner-funded) - ' || v_landlord_name
        )
      ),
      idempotency_key := 'psm-float-' || v_line.line_id::text
    );

    -- Landlord Float Pool (self-managed top-ups): reserve this top-up line first.
    IF v_pool_pid IS NOT NULL THEN
      BEGIN
        PERFORM public.landlord_pool_reserve_increment(v_pool_pid, 'topup', v_line.principal,
          'partner_self_funding_lines', v_line.line_id, 'psm_self_topup');
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
        VALUES (v_pool_pid, 'reserve', 'psm_self_topup', SQLERRM,
                jsonb_build_object('sqlstate', SQLSTATE, 'topup_id', p_topup_id, 'line_id', v_line.line_id));
      END;
    END IF;

    -- Landlord Float Pool: this tenant line was reserved as self-support, so
    -- the money leaves the pool now, beside the rent_disbursement above.
    v_pool_entry := NULL;
    SELECT e.id INTO v_pool_entry FROM public.landlord_pool_entries e
     WHERE e.source_table = 'partner_self_funding_lines' AND e.source_id = v_line.line_id
       AND e.status = 'open' AND e.in_pool > 0;
    IF v_pool_entry IS NOT NULL THEN
      v_pool_drawn := v_pool_drawn + coalesce((public.landlord_pool_deploy(
        v_line.rent_request_id, v_line.principal, 'self_support', v_alloc, v_pool_entry,
        'psm_disburse_landlord_float') ->> 'drawn')::numeric, 0);
    END IF;

    INSERT INTO public.agent_float_funding (agent_id, amount, funded_by, rent_request_id, notes)
    VALUES (v_agent, v_line.principal, auth.uid(), v_line.rent_request_id,
            'Partner-funded landlord float for ' || v_landlord_name)
    ON CONFLICT DO NOTHING;

    UPDATE public.rent_requests
       SET status = 'funded',
           funded_at = COALESCE(funded_at, now()),
           self_funding_partner_id = COALESCE(self_funding_partner_id, v_partner),
           self_funding_line_id = COALESCE(self_funding_line_id, v_line.line_id),
           updated_at = now()
     WHERE id = v_line.rent_request_id
       AND status IN ('approved','coo_approved','pending','agent_ops_approved',
                      'tenant_ops_approved','landlord_ops_approved','cfo_approved');

    v_treasury := public.recognise_funding_treasury(v_line.rent_request_id);
    IF (v_treasury->>'status') = 'recognised' THEN
      v_treasury_recognised := v_treasury_recognised + 1;
    END IF;

    v_funded := v_funded + 1;
    v_total := v_total + v_line.principal;
  END LOOP;

  WITH grouped AS (
    SELECT a.agent_id, a.landlord_id,
           MIN(a.landlord_name) AS landlord_name,
           SUM(a.allocated_amount) AS amount,
           COUNT(DISTINCT a.rent_request_id)::int AS tenant_count,
           array_agg(DISTINCT a.rent_request_id) AS rent_request_ids
      FROM public.agent_landlord_float_allocations a
     WHERE a.id = ANY(v_alloc_ids)
       AND a.status NOT IN ('cancelled','reversed')
     GROUP BY a.agent_id, a.landlord_id
  ), ins AS (
    INSERT INTO public.partner_float_agent_notices (
      commitment_id, topup_id, partner_id, agent_id, landlord_id,
      landlord_name, amount, tenant_count, rent_request_ids
    )
    SELECT p_commitment_id, p_topup_id, v_partner, g.agent_id, g.landlord_id,
           COALESCE(g.landlord_name,'the landlord'), g.amount, g.tenant_count, g.rent_request_ids
      FROM grouped g
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_notices FROM ins;

  -- Landlord SMS queue (5a). One row per agent+landlord, like the agent notices.
  -- The landlord is told their rent is approved and who will pay them, because
  -- the money now sits on the agent's dashboard. Never blocks the approval.
  BEGIN
    INSERT INTO public.partner_float_landlord_notices (
      commitment_id, topup_id, partner_id, agent_id, agent_name, landlord_id,
      landlord_name, landlord_phone, amount, tenant_count, tenant_first_names, rent_request_ids
    )
    SELECT p_commitment_id, p_topup_id, v_partner, g.agent_id, g.agent_name, g.landlord_id,
           COALESCE(g.landlord_name, 'the landlord'), g.landlord_phone, g.amount, g.tenant_count,
           COALESCE(g.tenant_names, '{}'::text[]), g.rent_request_ids
      FROM (
        SELECT a.agent_id, a.landlord_id,
               MIN(pa.full_name)                       AS agent_name,
               MIN(a.landlord_name)                    AS landlord_name,
               MIN(ld.phone)                           AS landlord_phone,
               SUM(a.allocated_amount)                 AS amount,
               COUNT(DISTINCT a.rent_request_id)::int  AS tenant_count,
               array_agg(DISTINCT initcap(split_part(btrim(pt.full_name), ' ', 1)))
                 FILTER (WHERE btrim(COALESCE(pt.full_name, '')) <> '') AS tenant_names,
               array_agg(DISTINCT a.rent_request_id)   AS rent_request_ids
          FROM public.agent_landlord_float_allocations a
          LEFT JOIN public.profiles  pa ON pa.id = a.agent_id
          LEFT JOIN public.profiles  pt ON pt.id = a.tenant_id
          LEFT JOIN public.landlords ld ON ld.id = a.landlord_id
         WHERE a.id = ANY(v_alloc_ids)
           AND a.status NOT IN ('cancelled', 'reversed')
         GROUP BY a.agent_id, a.landlord_id
      ) g
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.psm_audit(auth.uid(), v_partner, 'landlord_sms_queue_failed',
      'partner_self_commitments', p_commitment_id, jsonb_build_object('error', SQLERRM));
  END;

  PERFORM public.psm_audit(auth.uid(), v_partner, 'landlord_float_disbursed',
    'partner_self_commitments', p_commitment_id,
    jsonb_build_object('funded_lines', v_funded, 'skipped_lines', v_skipped,
                       'total_amount', v_total, 'notices_queued', v_notices,
                       'treasury_recognised', v_treasury_recognised,
                       'topup_id', p_topup_id,
                       'landlord_pool_drawn', v_pool_drawn));

  RETURN jsonb_build_object('funded', v_funded, 'skipped', v_skipped,
                            'total_amount', v_total, 'notices_queued', v_notices,
                            'treasury_recognised', v_treasury_recognised,
                            'landlord_pool_drawn', v_pool_drawn);
END;
$function$;

-- 6. The portfolio goes inactive when the contract term ends -------------------
-- Self-support portfolios only (tenant and house) and only commitments on the
-- 12-month contract: older 1-month commitments are left exactly as they are.
-- Waits for the final return cycle to be accrued (the 01:10 accrual job), skips
-- a portfolio on a CFO hold, and records every flip. Pool money is released by
-- the existing redemption flow (the pool release trigger acts on redeemed).
CREATE OR REPLACE FUNCTION public.psm_mature_self_support_portfolios()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r         record;
  v_today   date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_done    integer := 0;
  v_waiting integer := 0;
  v_failed  integer := 0;
BEGIN
  FOR r IN
    SELECT ip.id AS portfolio_id, ip.portfolio_code, ip.investor_id,
           c.id AS commitment_id, c.status AS commitment_status, c.next_payout_at
      FROM public.investor_portfolios ip
      JOIN LATERAL (
        SELECT fp.commitment_id
          FROM public.funder_pending_portfolios fp
         WHERE fp.portfolio_id = ip.id
           AND fp.source IN ('self_managed', 'self_managed_house')
           AND fp.commitment_id IS NOT NULL
         ORDER BY fp.created_at
         LIMIT 1
      ) src ON true
      JOIN public.partner_self_commitments c ON c.id = src.commitment_id
     WHERE ip.status = 'active'
       AND COALESCE(c.term_months, 1) >= public.psm_contract_term_months()
       AND (
            c.status = 'matured'
         OR (ip.maturity_date IS NOT NULL AND ip.maturity_date <= v_today)
       )
     ORDER BY ip.maturity_date NULLS LAST
     FOR UPDATE OF ip SKIP LOCKED
  LOOP
    BEGIN
      -- The last monthly return must be recorded before the portfolio closes.
      IF r.commitment_status = 'active'
         AND r.next_payout_at IS NOT NULL
         AND r.next_payout_at::date <= v_today THEN
        v_waiting := v_waiting + 1;
        CONTINUE;
      END IF;

      UPDATE public.investor_portfolios SET status = 'matured'
       WHERE id = r.portfolio_id AND status = 'active';
      UPDATE public.partner_self_commitments SET status = 'matured'
       WHERE id = r.commitment_id AND status = 'active';

      PERFORM public.psm_audit(NULL, r.investor_id, 'self_support_portfolio_matured',
        'investor_portfolios', r.portfolio_id,
        jsonb_build_object('portfolio_code', r.portfolio_code, 'commitment_id', r.commitment_id));
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      BEGIN
        INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
        VALUES (r.investor_id, 'psm_mature_failed', 'investor_portfolios', r.portfolio_id::text,
                'Self-support portfolio could not be matured automatically',
                jsonb_build_object('portfolio_code', r.portfolio_code, 'error', SQLERRM, 'sqlstate', SQLSTATE));
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END;
  END LOOP;

  RETURN jsonb_build_object('matured', v_done, 'waiting_for_final_cycle', v_waiting, 'failed', v_failed);
END;
$function$;

REVOKE ALL ON FUNCTION public.psm_mature_self_support_portfolios() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_mature_self_support_portfolios() TO service_role;

-- Daily at 01:40 UTC, after the returns accrual (01:10) and payouts (01:25).
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'psm-mature-self-support-portfolios';
  PERFORM cron.schedule('psm-mature-self-support-portfolios', '40 1 * * *',
                        'select public.psm_mature_self_support_portfolios();');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron not available: %', SQLERRM;
END $$;

-- 7. Commitments still waiting for approval move to the 12-month term ---------
-- Approved (legacy) commitments are left as they are.
UPDATE public.partner_self_commitments c
   SET term_months = public.psm_contract_term_months(),
       term_end_at = CASE WHEN c.payout_anchor_at IS NOT NULL
                          THEN c.payout_anchor_at + (public.psm_contract_term_months() || ' months')::interval
                          ELSE c.term_end_at END
 WHERE c.status = 'pending_ops_approval'
   AND COALESCE(c.term_months, 1) < public.psm_contract_term_months();

UPDATE public.partner_self_funding_lines l
   SET term_months = public.psm_contract_term_months(),
       term_end_at = (SELECT c.term_end_at FROM public.partner_self_commitments c WHERE c.id = l.commitment_id)
 WHERE l.commitment_id IN (SELECT id FROM public.partner_self_commitments
                            WHERE status = 'pending_ops_approval')
   AND COALESCE(l.term_months, 1) < public.psm_contract_term_months();

UPDATE public.partner_supported_houses s
   SET term_months = public.psm_contract_term_months()
 WHERE s.commitment_id IN (SELECT id FROM public.partner_self_commitments
                            WHERE status = 'pending_ops_approval')
   AND COALESCE(s.term_months, 1) < public.psm_contract_term_months();

UPDATE public.funder_pending_portfolios fp
   SET term_months = public.psm_contract_term_months()
 WHERE fp.status = 'pending'
   AND fp.source IN ('self_managed', 'self_managed_house')
   AND COALESCE(fp.term_months, 1) < public.psm_contract_term_months();

UPDATE public.investor_portfolios ip
   SET duration_months = public.psm_contract_term_months()
 WHERE ip.status = 'pending_ops_approval'
   AND ip.id IN (SELECT fp.portfolio_id FROM public.funder_pending_portfolios fp
                  WHERE fp.status = 'pending' AND fp.source IN ('self_managed', 'self_managed_house'))
   AND COALESCE(ip.duration_months, 1) < public.psm_contract_term_months();