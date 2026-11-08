-- Partner Returns per person (Phase 2: every creation path uses the rule)
--
-- Phase 1 built the one rule (partner_rates_for) and the gate on investor_portfolios. Phase 2
-- makes every place that creates a portfolio, a promissory note or a Returns figure take its
-- number from that rule, and nowhere else:
--   A. Shared helpers: partner_rate_now (one person's rate, or an error), the commitment
--      follow-up (self-managed rows carry the portfolio's stored rate), partner_quote_rate
--      (who a quoted figure is for: the public, me, or a partner staff are serving).
--   B. The creation paths. Each portfolio is inserted WITHOUT a typed rate; the gate decides it,
--      and the related commitment, funding lines and houses are given the rate the gate STORED.
--      Payroll reinvestment says it is payroll (the gate then gives the employee rate).
--   C. Promissory notes: figures come from the note's stamped rate; one call creates a split
--      booking (one note per house); a note that existed at the cut-off but is linked to its
--      person only later sends that person's lower-rated portfolios to the CFO.
--   D. Quotes and notices that still worked out 15%: they now use the stored rate, or the
--      public new-partner rate for offers and share links.
--   E. The old rent-facilitation reward (fund-tenants): each funding stores the supporter's
--      rate, and the reward is paid at that stored rate.
--   F. Monitoring checks for all of the above. The switch still cannot go on: release_ready is
--      set by the release migration (Phase 7), after agreements, edge functions and screens.
--
-- With the switch OFF every path gives exactly what production gives today (15%, payroll 20%).
-- The tenant side (Rent Plan fee split, 360 tenant engine) is untouched.

SET LOCAL lock_timeout = '1s';   -- not 5s: everything queues behind a waiting lock; on a timeout retry the apply
-- Strong locks once, up front, in a fixed order (triggers are added to these tables below).
LOCK TABLE public.promissory_notes, public.rent_requests IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.promissory_note_pledge_notices, public.promissory_house_booking_notices,
           public.funder_house_progress_notices IN ACCESS EXCLUSIVE MODE;

-- ===========================================================================
-- A. Shared helpers
-- ===========================================================================

-- One person's rate for a NEW portfolio, from the one rule. Fails closed: no number, no insert.
CREATE OR REPLACE FUNCTION public.partner_rate_now(p_partner uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rate numeric;
BEGIN
  SELECT r.rate INTO v_rate FROM public.partner_rates_for(ARRAY[p_partner], true) r;
  IF v_rate IS NULL THEN
    RAISE EXCEPTION 'PARTNER_RATE_UNAVAILABLE: no Partner Returns rate could be decided for this partner'
      USING ERRCODE = '55000';
  END IF;
  RETURN v_rate;
END $function$;
REVOKE ALL ON FUNCTION public.partner_rate_now(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_rate_now(uuid) TO service_role;

-- Self-managed Returns are paid from the commitment, its open funding lines and its houses, so
-- they must carry the rate stored on the portfolio. Called right after the portfolio insert;
-- in practice it changes nothing (the creation path asked the same rule a moment earlier), but
-- a concurrent change (a switch-on between the two statements) can never leave them apart.
CREATE OR REPLACE FUNCTION public._partner_commitment_follow_rate(p_commitment_id uuid, p_rate numeric)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.partner_self_commitments c SET monthly_rate = p_rate
   WHERE c.id = p_commitment_id AND c.monthly_rate IS DISTINCT FROM p_rate;
  UPDATE public.partner_self_funding_lines l SET monthly_rate = p_rate
   WHERE l.commitment_id = p_commitment_id AND l.monthly_rate IS DISTINCT FROM p_rate;
  UPDATE public.partner_supported_houses h SET monthly_rate = p_rate
   WHERE h.commitment_id = p_commitment_id AND h.cancelled_at IS NULL AND h.monthly_rate IS DISTINCT FROM p_rate;
$function$;
REVOKE ALL ON FUNCTION public._partner_commitment_follow_rate(uuid, numeric) FROM PUBLIC, anon, authenticated, service_role;

-- Who a quoted Returns figure is for. Screens and RPCs say it; they never guess from the caller.
--   'public'  - the public new-partner rate (offers, share text, calculators). Anyone.
--   'me'      - the signed-in caller's own rate.
--   'partner' - a named partner's rate: staff who serve partners, or a backend.
-- Agents quote the public rate (about 59k accounts hold an agent role; a per-person answer would
-- reveal who is staff or an existing partner).
CREATE OR REPLACE FUNCTION public.partner_quote_rate(p_quote_for text DEFAULT 'public', p_partner_id uuid DEFAULT NULL)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_for text := lower(COALESCE(NULLIF(btrim(p_quote_for), ''), 'public'));
BEGIN
  IF v_for = 'public' THEN
    RETURN public.partner_new_contract_rate();
  ELSIF v_for = 'me' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'AUTH_REQUIRED: sign in to see your own Returns rate' USING ERRCODE = '42501';
    END IF;
    RETURN public.partner_rate_now(auth.uid());
  ELSIF v_for = 'partner' THEN
    IF p_partner_id IS NULL THEN
      RAISE EXCEPTION 'PARTNER_REQUIRED' USING ERRCODE = '22023';
    END IF;
    IF NOT public._partner_return_policy_caller_ok(
             ARRAY['partner_ops', 'coo', 'cfo', 'ceo', 'super_admin', 'manager', 'financial_ops']) THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED: only partner staff can quote a named partner''s rate'
        USING ERRCODE = '42501';
    END IF;
    RETURN public.partner_rate_now(p_partner_id);
  END IF;
  RAISE EXCEPTION 'INVALID_QUOTE_FOR: use public, me or partner' USING ERRCODE = '22023';
END $function$;
REVOKE ALL ON FUNCTION public.partner_quote_rate(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_quote_rate(text, uuid) TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.partner_quote_rate(text, uuid) IS
  'The monthly Partner Returns rate a quoted figure is for: public (new partners), me (the caller) or partner (a named partner; staff only).';

-- ===========================================================================
-- B. Creation paths. The portfolio is inserted without a rate (the gate decides it); related
--    rows get the rate the gate stored.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- funder_create_pending_portfolio: the gate decides the rate; the result says which.
-- ---------------------------------------------------------------------------
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
  v_rate numeric;
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
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_uid, COALESCE(v_agent, v_uid), v_code, p_amount,
    GREATEST(1, LEAST(COALESCE(p_term_months,12), 60)),
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_rate;

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
    'roi_percentage', v_rate,
    'funding_source', 'operational_float',
    'available_balance', public.funder_float_capacity(v_uid)
  );
END;
$function$
;


-- ---------------------------------------------------------------------------
-- psm_confirm_commitment_for (note approval, direct tenant support, self-support): the person's
-- rate from the rule; the commitment and lines follow the rate the gate stored.
-- ---------------------------------------------------------------------------
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
  v_rate numeric;
  v_stored numeric;
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

  v_rate := public.partner_rate_now(p_partner);

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
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    p_partner, COALESCE(v_agent, p_partner), v_code, v_total, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment_id, v_stored);
    v_rate := v_stored;
  END IF;

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
    'roi_percentage', v_rate,
    'portfolio_id', v_portfolio_id,
    'promissory_note_id', v_note,
    'funding_mode', v_mode,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(p_partner)
  );
END;
$function$
;


-- ---------------------------------------------------------------------------
-- partner_support_houses (3 args): the person's rate from the rule; houses follow the stored rate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric;
  v_stored numeric;
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

  v_rate := public.partner_rate_now(v_partner);

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment_id, v_stored);
    v_rate := v_stored;
  END IF;

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
    'roi_percentage', v_rate,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$
;


-- ---------------------------------------------------------------------------
-- partner_support_houses (4 args): a new commitment takes the person's rate from the rule; a
-- top-up of an existing commitment keeps the rate stored on its portfolio. funder_fund_booked_houses
-- books every held house through ONE new commitment here, so a booking resolves one rate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_commitment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric;
  v_stored numeric;
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

    SELECT h.portfolio_id INTO v_portfolio_id FROM public.partner_supported_houses h
     WHERE h.commitment_id = v_target.id AND h.status <> 'cancelled' AND h.portfolio_id IS NOT NULL
     ORDER BY h.portfolio_id LIMIT 1;
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

    -- A top-up keeps the rate stored on the portfolio (existing partners keep their rate).
    SELECT ip.roi_percentage INTO v_rate FROM public.investor_portfolios ip WHERE ip.id = v_portfolio_id;
    v_rate := COALESCE(v_rate, v_target.monthly_rate);

    INSERT INTO public.partner_supported_houses (
      partner_id, house_id, commitment_id, portfolio_id, principal, monthly_rate, term_months,
      status, landlord_id, listing_agent_id, metadata
    )
    SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal,
           v_rate, COALESCE(v_target.term_months, v_term),
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
      'monthly_return', round(v_total * v_rate / 100),
      'roi_percentage', v_rate,
      'status', 'pending_ops_approval',
      'available_balance', public.funder_float_available(v_partner)
    );
  END IF;

  v_rate := public.partner_rate_now(v_partner);

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment_id, v_stored);
    v_rate := v_stored;
  END IF;

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
    'roi_percentage', v_rate,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$
;


-- ---------------------------------------------------------------------------
-- countersign_prepare_support: the auto-created company-managed portfolio gets the gate's rate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.countersign_prepare_support(p_partner_id uuid, p_amount numeric, p_support_mode text, p_return_option text, p_actor uuid, p_countersign_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a          public.partner_agreements%ROWTYPE;
  v_amount   numeric;
  v_exist    numeric;
  v_count    integer;
  v_needed   numeric;
  v_float    numeric;
  v_option   text;
  v_mode     text;
  v_pid      uuid;
  v_code     text;
  v_group    uuid;
  v_today    date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_roi_mode text;
  v_rate     numeric;
BEGIN
  IF p_actor IS NULL OR NOT public.is_partner_ops(p_actor) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED',
      'message', 'Only Partner Operations can countersign.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('countersign-prepare-' || p_partner_id::text));

  SELECT * INTO a FROM public.partner_agreements WHERE partner_id = p_partner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_AGREEMENT', 'message', 'No agreement found for this partner.');
  END IF;

  v_mode := coalesce(p_support_mode, a.support_mode);
  IF v_mode IS NULL OR v_mode NOT IN ('company_managed', 'self_support') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUPPORT_MODE_REQUIRED',
      'message', 'Choose how this partner will support (company-managed or self-support) before countersigning.');
  END IF;

  v_amount := coalesce(nullif(p_amount, 0), nullif(a.partnership_amount, 0), 0);
  IF v_amount < 20000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT',
      'message', 'The contract amount must be at least UGX 20,000.');
  END IF;

  SELECT existing_total, existing_count INTO v_exist, v_count FROM public._partner_contract_coverage(p_partner_id);
  v_needed := greatest(0, v_amount - v_exist);
  v_float  := coalesce(public.funder_float_available(p_partner_id), 0);

  IF p_countersign_only AND v_needed > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONTRACT_NOT_COVERED', 'needed', v_needed,
      'message', format('The contract (UGX %s) is more than this partner''s portfolios (UGX %s). Countersign from the Sign-off dialog so the difference is handled.',
                        to_char(v_amount, 'FM999,999,999,999'), to_char(v_exist, 'FM999,999,999,999')));
  END IF;

  IF v_float < v_needed THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLOAT_SHORT',
      'needed', v_needed, 'float_available', v_float, 'shortfall', v_needed - v_float,
      'message', format('Operational float is short by UGX %s. Needed UGX %s, available UGX %s. Nothing was sent.',
                        to_char(v_needed - v_float, 'FM999,999,999,999'),
                        to_char(v_needed, 'FM999,999,999,999'), to_char(v_float, 'FM999,999,999,999')));
  END IF;

  -- A self-registered funder must be verified by Partner Ops before any
  -- portfolio can be created for them (enforce_funder_verified_for_portfolio).
  -- Refuse cleanly here instead of letting the trigger raise a 500.
  IF v_mode = 'company_managed' AND v_needed > 0 AND EXISTS (
       SELECT 1 FROM public.profiles pr
        WHERE pr.id = p_partner_id
          AND pr.signup_source = 'funder-onboarding'
          AND pr.funder_verified_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FUNDER_NOT_VERIFIED',
      'message', 'This partner signed up on their own and has not been verified yet. Verify the partner first, then countersign. Nothing was sent.');
  END IF;

  v_option := coalesce(
    CASE WHEN p_return_option IN ('A', 'B') THEN p_return_option END,
    CASE WHEN a.return_option IN ('A', 'B') THEN a.return_option END,
    (SELECT CASE ip.roi_mode WHEN 'monthly_payout' THEN 'A' WHEN 'monthly_compounding' THEN 'B' END
       FROM public.investor_portfolios ip
      WHERE ip.investor_id = p_partner_id ORDER BY ip.created_at LIMIT 1),
    'A');

  IF v_mode = 'company_managed' AND v_needed > 0 THEN
    v_roi_mode := CASE v_option WHEN 'A' THEN 'monthly_payout' ELSE 'monthly_compounding' END;

    v_pid := gen_random_uuid();
    LOOP
      v_code := 'WIP' || to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') || lpad((floor(random()*9000)+1000)::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.investor_portfolios WHERE portfolio_code = v_code);
    END LOOP;

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', p_partner_id, 'amount', v_needed, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'description', format('Operational float deployed to portfolio %s on agreement countersign (float_usage=partner_portfolio_funding)', v_code),
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', 'platform'),
        jsonb_build_object(
          'amount', v_needed, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'description', format('Platform capital received for portfolio %s (agreement countersign)', v_code),
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', p_partner_id::text)),
      idempotency_key := 'portfolio-funding-' || v_pid::text);

    INSERT INTO public.investor_portfolios (
      id, investor_id, agent_id, portfolio_code, investment_amount,
      roi_mode, duration_months, payout_day,
      next_roi_date, maturity_date, status, portfolio_pin, activation_token, auto_reinvest,
      cfo_verified, cfo_verified_at, cfo_verified_by
    ) VALUES (
      v_pid, p_partner_id, p_partner_id, v_code, v_needed,
      v_roi_mode, 12, least(extract(day FROM v_today)::int, 28),
      (v_today + interval '1 month')::date, (v_today + interval '12 months')::date,
      'active', lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), false,
      true, now(), p_actor
    ) RETURNING roi_percentage INTO v_rate;

    INSERT INTO public.wallet_transactions (sender_id, recipient_id, amount, description)
    VALUES (p_partner_id, p_partner_id, v_needed, 'Portfolio funded: ' || v_code);

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
    VALUES (p_actor, 'countersign_auto_portfolio', 'investor_portfolios', v_pid::text,
      'countersign_auto_portfolio', 'Portfolio created automatically on agreement countersign (company-managed)',
      jsonb_build_object('partner_id', p_partner_id, 'contract_amount', v_amount, 'existing_total', v_exist,
                         'created_amount', v_needed, 'portfolio_code', v_code, 'return_option', v_option,
                         'ledger_group_id', v_group, 'float_before', v_float));
  END IF;

  UPDATE public.partner_agreements
     SET partnership_amount = v_amount,
         partnership_amount_words = CASE WHEN partnership_amount IS DISTINCT FROM v_amount THEN NULL ELSE partnership_amount_words END,
         return_option = v_option,
         support_mode = v_mode,
         support_mode_set_at = CASE WHEN support_mode IS DISTINCT FROM v_mode THEN now() ELSE support_mode_set_at END,
         support_mode_set_by = CASE WHEN support_mode IS DISTINCT FROM v_mode THEN p_actor ELSE support_mode_set_by END,
         self_support_allowance = CASE WHEN v_mode = 'self_support' THEN v_needed ELSE NULL END,
         auto_portfolio_id = coalesce(v_pid, auto_portfolio_id)
   WHERE id = a.id;

  RETURN jsonb_build_object('ok', true, 'support_mode', v_mode, 'contract_amount', v_amount,
    'existing_total', v_exist, 'needed', v_needed, 'float_available', v_float,
    'portfolio_id', v_pid, 'portfolio_code', v_code, 'return_option', v_option,
    'roi_percentage', v_rate,
    'self_support_allowance', CASE WHEN v_mode = 'self_support' THEN v_needed END);
END;
$function$
;


-- ---------------------------------------------------------------------------
-- get_countersign_summary: shows the rate THIS partner's new portfolio would get.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_countersign_summary(p_partner_id uuid, p_amount numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a        public.partner_agreements%ROWTYPE;
  v_amount numeric;
  v_exist  numeric;
  v_count  integer;
  v_float  numeric;
  v_needed numeric;
  v_option text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_partner_ops(auth.uid()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  SELECT * INTO a FROM public.partner_agreements WHERE partner_id = p_partner_id;
  SELECT existing_total, existing_count INTO v_exist, v_count FROM public._partner_contract_coverage(p_partner_id);

  v_amount := coalesce(nullif(p_amount, 0), nullif(a.partnership_amount, 0), 0);
  v_needed := greatest(0, v_amount - v_exist);
  v_float  := coalesce(public.funder_float_available(p_partner_id), 0);

  v_option := coalesce(
    CASE WHEN a.return_option IN ('A', 'B') THEN a.return_option END,
    (SELECT CASE ip.roi_mode WHEN 'monthly_payout' THEN 'A'
                             WHEN 'monthly_compounding' THEN 'B' END
       FROM public.investor_portfolios ip
      WHERE ip.investor_id = p_partner_id ORDER BY ip.created_at LIMIT 1),
    'A');

  RETURN jsonb_build_object(
    'contract_amount', v_amount,
    'stored_amount', coalesce(a.partnership_amount, 0),
    'existing_total', v_exist,
    'existing_count', v_count,
    'needed', v_needed,
    'float_available', v_float,
    'shortfall', greatest(0, v_needed - v_float),
    'covered', v_float >= v_needed,
    'return_option', v_option,
    'support_mode', a.support_mode,
    'countersigned', a.countersigned_at IS NOT NULL OR a.status = 'countersigned',
    'self_support_remaining', CASE WHEN a.support_mode = 'self_support' THEN v_needed END,
    'roi_percentage', public.partner_rate_now(p_partner_id),
    'duration_months', 12
  );
END;
$function$
;


-- ---------------------------------------------------------------------------
-- create_pending_portfolio (partner-completion invite created by Partner Ops). A rate is passed
-- only when staff typed one; left out (NULL), the gate gives the person's rate. A typed rate that
-- differs from the person's rate is stored at the person's rate and waits for the CFO.
-- ---------------------------------------------------------------------------
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
  v_rate numeric;
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

  IF p_roi_percentage IS NOT NULL AND (p_roi_percentage <= 0 OR p_roi_percentage > 100) THEN
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
  RETURNING id, roi_percentage INTO v_pid, v_rate;

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
      'roi_percentage', v_rate,
      'requested_roi_percentage', p_roi_percentage,
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
$function$
;


-- ---------------------------------------------------------------------------
-- hr_pay_post_staff_reinvestment: salary reinvestment earns the employee rate (no CFO request),
-- including a leaver's final payslip. The function tells the gate it is payroll through a
-- transaction-local setting (browsers cannot set app.* settings) and clears it straight after
-- the insert, so nothing later in the same transaction inherits it. The notification quotes the
-- rate actually stored on the portfolio.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hr_pay_post_staff_reinvestment(_payslip_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_existing   public.hr_pay_staff_reinvestments%rowtype;
  v_ps         record;
  v_amount     numeric;
  v_pct        smallint;
  v_mode       text;
  v_disb       text;
  v_pid        uuid;
  v_code       text;
  v_group      uuid;
  v_op         uuid;
  v_kind       text;
  v_payout_day int;
  v_rate       numeric;
begin
  perform pg_advisory_xact_lock(hashtext('staff-reinvest-' || _payslip_id::text));

  select * into v_existing from public.hr_pay_staff_reinvestments where payslip_id = _payslip_id;
  if v_existing.id is not null then
    return jsonb_build_object('status', 'already_posted', 'portfolio_id', v_existing.portfolio_id,
                              'amount', v_existing.amount);
  end if;

  select ps.id, ps.run_id, ps.staff_id, ps.is_current, ps.inputs_snapshot, ps.net,
         s.user_id, s.staff_ref, r.status as run_status, pe.code as period_code
    into v_ps
  from public.hr_pay_payslips ps
  join public.hr_staff s on s.id = ps.staff_id
  join public.hr_pay_runs r on r.id = ps.run_id
  join public.hr_pay_periods pe on pe.id = r.period_id
  where ps.id = _payslip_id;

  if v_ps.id is null then raise exception 'PAYSLIP_NOT_FOUND'; end if;
  if not v_ps.is_current then raise exception 'PAYSLIP_NOT_CURRENT'; end if;
  if v_ps.run_status not in ('approved','paid','locked') then
    raise exception 'RUN_NOT_APPROVED' using hint = v_ps.run_status;
  end if;

  select coalesce(sum(l.amount), 0) into v_amount
    from public.hr_pay_payslip_lines l
   where l.payslip_id = _payslip_id and l.component_code = 'REINVEST';
  if v_amount <= 0 then
    return jsonb_build_object('status', 'none');
  end if;

  select d.status into v_disb from public.hr_pay_disbursements d where d.payslip_id = _payslip_id limit 1;
  if coalesce(v_ps.net, 0) > 0 and coalesce(v_disb, '') not in ('posted','skipped') then
    raise exception 'SALARY_NOT_RELEASED' using hint = coalesce(v_disb, 'no disbursement');
  end if;

  if v_ps.user_id is null then raise exception 'STAFF_HAS_NO_USER'; end if;

  v_pct := nullif(v_ps.inputs_snapshot->'reinvestment'->>'percentage', '')::smallint;
  v_mode := nullif(v_ps.inputs_snapshot->'reinvestment'->>'payout_mode', '');
  if v_mode is null then
    select r.payout_mode into v_mode
      from public.staff_survey_responses r
      join public.staff_surveys sv on sv.id = r.survey_id and sv.kind = 'reinvestment_pledge'
     where r.user_id = v_ps.user_id and r.response = 'pledge' and r.payout_mode is not null
     order by r.cycle_start desc, r.responded_at desc
     limit 1;
  end if;
  if v_mode is null then raise exception 'RETURN_OPTION_NOT_CHOSEN'; end if;

  select r.portfolio_id into v_pid
    from public.hr_pay_staff_reinvestments r
    join public.investor_portfolios ip on ip.id = r.portfolio_id
   where r.user_id = v_ps.user_id
     and ip.status in ('pending_ops_approval','awaiting_partner_details','active')
   order by r.created_at desc
   limit 1;

  if v_pid is null then
    v_kind := 'portfolio_created';
    v_pid := gen_random_uuid();
    v_code := 'WSR' || to_char(now() at time zone 'UTC', 'YYMMDD')
              || lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');
    v_payout_day := least(extract(day from (now() at time zone 'UTC'))::int, 28);

    -- The employee rate comes from the policy (20 today). No policy row: refuse, never guess.
    select trim_scale(p.employee_rate) into v_rate from public.partner_return_policy p where p.id;
    if v_rate is null then raise exception 'PARTNER_RETURN_POLICY_MISSING'; end if;

    perform set_config('app.partner_rate_context', 'salary_reinvestment', true);
    insert into public.investor_portfolios (
      id, investor_id, agent_id, portfolio_code, investment_amount,
      roi_percentage, roi_mode, duration_months, payout_day, next_roi_date,
      status, portfolio_pin, activation_token, auto_reinvest, investment_reference
    ) values (
      v_pid, v_ps.user_id, v_ps.user_id, v_code, v_amount,
      v_rate, v_mode, 12, v_payout_day, ((now() at time zone 'UTC')::date + interval '1 month')::date,
      'awaiting_partner_details', lpad((floor(random() * 9000) + 1000)::int::text, 4, '0'),
      gen_random_uuid(), false,
      'Staff salary reinvestment · ' || coalesce(v_ps.staff_ref, '')
    ) returning roi_percentage into v_rate;
    perform set_config('app.partner_rate_context', '', true);

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_out', 'category', 'salary_payout',
          'ledger_scope', 'platform',
          'source_table', 'hr_pay_payslips', 'source_id', _payslip_id,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Salary reinvested by ' || coalesce(v_ps.staff_ref, 'staff')
                         || ' into staff portfolio ' || v_code),
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_in', 'category', 'partner_funding',
          'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Staff salary reinvestment capital received for portfolio ' || v_code
                         || ' (float_usage=portfolio_funding)')
      ),
      idempotency_key := 'staff-reinvest-' || _payslip_id::text
    );
  else
    v_kind := 'topup';
    select portfolio_code, roi_percentage into v_code, v_rate from public.investor_portfolios where id = v_pid;

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_out', 'category', 'salary_payout',
          'ledger_scope', 'platform',
          'source_table', 'hr_pay_payslips', 'source_id', _payslip_id,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Salary reinvested by ' || coalesce(v_ps.staff_ref, 'staff')
                         || ' as a top-up to staff portfolio ' || v_code),
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_in', 'category', 'pending_portfolio_topup',
          'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', v_ps.user_id::text,
          'description', 'Staff salary reinvestment top-up parked for portfolio ' || v_code)
      ),
      idempotency_key := 'staff-reinvest-' || _payslip_id::text
    );

    insert into public.pending_wallet_operations (
      user_id, amount, direction, category, description, source_table, source_id,
      transaction_group_id, linked_party, reference_id, status, operation_type,
      payment_method, metadata, created_at, updated_at
    ) values (
      v_ps.user_id, v_amount, 'cash_in', 'pending_portfolio_topup',
      'Staff salary reinvestment top-up for ' || v_code,
      'investor_portfolios', v_pid, v_group, v_ps.user_id::text, v_code,
      'pending', 'portfolio_topup', 'payroll',
      jsonb_build_object('fund_source', 'payroll', 'staff_reinvestment', true,
                         'payslip_id', _payslip_id, 'run_id', v_ps.run_id,
                         'portfolio_code', v_code, 'percentage', v_pct,
                         'payout_mode_chosen', v_mode),
      now(), now()
    )
    returning id into v_op;
  end if;

  insert into public.hr_pay_staff_reinvestments (
    payslip_id, run_id, staff_id, user_id, amount, percentage, payout_mode,
    portfolio_id, kind, pending_op_id, ledger_group_id
  ) values (
    _payslip_id, v_ps.run_id, v_ps.staff_id, v_ps.user_id, v_amount, v_pct, v_mode,
    v_pid, v_kind, v_op, v_group
  );

  insert into public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  values (null, 'hr_pay_staff_reinvestment', 'investor_portfolios', v_pid::text,
          'Staff salary reinvestment posted',
          jsonb_build_object('payslip_id', _payslip_id, 'run_id', v_ps.run_id,
                             'staff_ref', v_ps.staff_ref, 'amount', v_amount,
                             'percentage', v_pct, 'payout_mode', v_mode, 'kind', v_kind,
                             'portfolio_code', v_code, 'ledger_group_id', v_group,
                             'roi_percentage', v_rate));

  insert into public.notifications (user_id, title, message, type, metadata)
  values (v_ps.user_id, 'Salary reinvested',
          format('UGX %s from your %s salary has been reinvested into your Welile portfolio %s, earning %s%% per month.',
                 to_char(v_amount, 'FM999,999,999,999'), v_ps.period_code, v_code, trim_scale(v_rate)),
          'success',
          jsonb_build_object('portfolio_id', v_pid, 'amount', v_amount, 'kind', v_kind));

  return jsonb_build_object('status', 'posted', 'kind', v_kind, 'portfolio_id', v_pid,
                            'portfolio_code', v_code, 'amount', v_amount, 'roi_percentage', v_rate);
end;
$function$
;


-- ===========================================================================
-- C. Promissory notes. A note's rate is stamped once when it is written (Phase 1 trigger); every
--    figure quoted for a note comes from that stamp.
-- ===========================================================================

-- Notice queues keep the rate behind the amounts they hold, so a sender never works it out
-- again. Nullable, no default: metadata-only, rows queued earlier simply have none.
ALTER TABLE public.promissory_note_pledge_notices   ADD COLUMN IF NOT EXISTS return_rate numeric(6,2);
ALTER TABLE public.promissory_house_booking_notices ADD COLUMN IF NOT EXISTS return_rate numeric(6,2);
ALTER TABLE public.funder_house_progress_notices    ADD COLUMN IF NOT EXISTS return_rate numeric(6,2);

-- What the caller of a note RPC sees of the note and its rate. THE rule for "may this viewer see this
-- note's rate" (Phase 4's _promissory_note_rate_view, behind the activation page, reads this helper).
-- A note is linked at insert to whoever owns the typed phone and, with the switch on, stamped with
-- that person's own rate (20 for an employee, an existing partner's own rate). An agent must not learn
-- it by typing a phone number (agents quote the public rate, see partner_quote_rate), so the rate and
-- its projections are left out, and so is the linked account's id, unless the rate is not a person's
-- rate (a 'legacy' note: the legacy rate, as every note while the switch is off; an unlinked 'new'
-- note: the public new-partner rate) or the note is the caller's. With the switch never on every note
-- is 'legacy', so the answer is production's (monthly_return / annual_return, note.partner_user_id).
-- The partner gets the figures in the pledge and booking notices, which for a linked note go to that
-- person's own contacts (_promissory_note_notice_contacts). The basis is never shown.
CREATE OR REPLACE FUNCTION public._promissory_note_rate_json(p_note public.promissory_notes, p_viewer uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_note.return_rate_basis = 'legacy'
      OR (p_note.partner_user_id IS NULL AND p_note.return_rate_basis = 'new')
      OR (p_viewer IS NOT NULL AND p_note.partner_user_id = p_viewer) THEN
      jsonb_build_object(
        'note', jsonb_set(to_jsonb(p_note) - 'return_rate_basis', '{return_rate}', to_jsonb(trim_scale(p_note.return_rate))),
        'return_rate', trim_scale(p_note.return_rate),
        'monthly_return', round(p_note.amount * p_note.return_rate / 100),
        'annual_return', round(p_note.amount * p_note.return_rate / 100 * 12))
    ELSE
      jsonb_build_object(
        'note', to_jsonb(p_note) - 'return_rate_basis' - 'return_rate' - 'partner_user_id',
        'return_rate', NULL, 'monthly_return', NULL, 'annual_return', NULL)
  END;
$function$;
REVOKE ALL ON FUNCTION public._promissory_note_rate_json(public.promissory_notes, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Where a note's pledge and booking notices go. A note linked to a person carries that person's own
-- rate, so its figures go only to that person's own contacts: the contacts typed on the note may be
-- anyone's (an agent can type a partner's phone and their own email, or their own number as
-- WhatsApp). The email is the login email (auth.users), which only the person's confirmation can
-- change; profiles.email can be edited by the agent who referred them. The phone is the profile
-- phone. A note the person wrote for themselves (a supporter booking for themselves) falls back to
-- the contacts they typed, which are their own. An unlinked note carries the public rate and keeps
-- the typed contacts, as before.
CREATE OR REPLACE FUNCTION public._promissory_note_notice_contacts(p_note public.promissory_notes, OUT phone text, OUT email text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_note.partner_user_id IS NULL
              THEN COALESCE(NULLIF(btrim(p_note.whatsapp_number), ''), NULLIF(btrim(p_note.phone_number), ''))
              WHEN p_note.partner_user_id = p_note.agent_id
              THEN COALESCE(NULLIF(btrim(pr.phone), ''), NULLIF(btrim(p_note.whatsapp_number), ''),
                            NULLIF(btrim(p_note.phone_number), ''))
              ELSE NULLIF(btrim(pr.phone), '') END,
         CASE WHEN p_note.partner_user_id IS NULL
              THEN NULLIF(btrim(p_note.email), '')
              WHEN p_note.partner_user_id = p_note.agent_id
              THEN COALESCE(NULLIF(btrim(u.email), ''), NULLIF(btrim(p_note.email), ''))
              ELSE NULLIF(btrim(u.email), '') END
    FROM (SELECT 1) AS one
    LEFT JOIN public.profiles pr ON pr.id = p_note.partner_user_id
    LEFT JOIN auth.users u ON u.id = p_note.partner_user_id;
$function$;
REVOKE ALL ON FUNCTION public._promissory_note_notice_contacts(public.promissory_notes) FROM PUBLIC, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- agent_create_promissory_note: projections use the note's stamped rate.
-- ---------------------------------------------------------------------------
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
    'support_mode', v_support_mode, 'attached_count', v_valid, 'attached_amount', v_sum
  ) || public._promissory_note_rate_json(v_note, v_uid);
END;
$function$
;


-- ---------------------------------------------------------------------------
-- psm_queue_promissory_pledge_notice: amounts from the note's stamped rate, kept on the notice.
-- ---------------------------------------------------------------------------
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
  v_to record;
BEGIN
  SELECT * INTO v_note FROM public.promissory_notes WHERE id = p_note_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT c.phone, c.email INTO v_to FROM public._promissory_note_notice_contacts(v_note) c;

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
    attached_count, attached_amount, monthly_return, annual_return, return_rate, tenants
  ) VALUES (
    p_note_id, v_note.partner_name,
    v_to.phone, v_to.email,
    v_note.amount, v_count, v_amount,
    round(v_note.amount * v_note.return_rate / 100), round(v_note.amount * v_note.return_rate / 100 * 12),
    v_note.return_rate,
    v_tenants
  )
  ON CONFLICT (note_id) DO NOTHING;
END;
$function$
;


-- ---------------------------------------------------------------------------
-- agent_create_promissory_note_for_houses: the projection uses the note's stamped rate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_create_promissory_note_for_houses(p_payload jsonb, p_house_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[] := COALESCE(p_house_ids, '{}'::uuid[]);
  v_amount numeric := COALESCE((p_payload->>'amount')::numeric, 0);
  v_name text := btrim(COALESCE(p_payload->>'partner_name', ''));
  v_whatsapp text := btrim(COALESCE(p_payload->>'whatsapp_number', ''));
  v_email text := lower(btrim(COALESCE(p_payload->>'email', '')));
  v_type text := COALESCE(NULLIF(btrim(p_payload->>'contribution_type'), ''), 'once_off');
  v_promised date := NULLIF(btrim(COALESCE(p_payload->>'promised_funding_date','')), '')::date;
  v_hold timestamptz := now() + interval '7 days';
  v_note public.promissory_notes;
  v_count integer := 0;
  v_rent_sum numeric := 0;
  v_is_agent boolean;
  v_is_supporter boolean;
  v_self boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  v_is_agent := public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
                OR public.has_role(v_uid, 'sub_agent') OR public.is_ops_role(v_uid);
  v_is_supporter := public.has_role(v_uid, 'supporter');

  IF NOT (v_is_agent OR v_is_supporter) THEN
    RAISE EXCEPTION 'Not authorised to create promissory notes' USING ERRCODE = '42501';
  END IF;

  v_self := (NOT v_is_agent) AND v_is_supporter;

  IF v_self THEN
    SELECT COALESCE(NULLIF(btrim(pr.full_name), ''), v_name),
           COALESCE(NULLIF(regexp_replace(COALESCE(pr.phone, ''), '\D', '', 'g'), ''), v_whatsapp),
           COALESCE(NULLIF(lower(btrim(COALESCE(pr.email, ''))), ''), v_email)
      INTO v_name, v_whatsapp, v_email
    FROM public.profiles pr WHERE pr.id = v_uid;
  END IF;

  IF length(v_name) < 3 THEN RAISE EXCEPTION 'Partner name is required' USING ERRCODE = '22023'; END IF;
  IF length(regexp_replace(v_whatsapp, '\D', '', 'g')) < 9 THEN RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023'; END IF;
  -- Email is optional; validate only when one was supplied.
  IF COALESCE(v_email,'') <> '' AND (length(v_email) > 255 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'EMAIL_INVALID: enter a valid email address or leave it blank.' USING ERRCODE = '22023';
  END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Promised amount must be greater than zero' USING ERRCODE = '22023'; END IF;
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'HOUSES_REQUIRED: select at least one empty house for this partner.' USING ERRCODE = '23514';
  END IF;
  IF v_promised IS NOT NULL AND v_promised < current_date THEN
    RAISE EXCEPTION 'PROMISED_DATE_PAST: the promised funding date cannot be in the past.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.promissory_notes (
    agent_id, partner_name, whatsapp_number, phone_number, email,
    amount, contribution_type, deduction_day, next_deduction_date, support_mode,
    partner_user_id
  ) VALUES (
    v_uid, v_name, v_whatsapp,
    NULLIF(btrim(COALESCE(p_payload->>'phone_number','')), ''),
    NULLIF(COALESCE(v_email,''), ''),
    v_amount,
    CASE WHEN v_type = 'monthly' THEN 'monthly' ELSE 'once_off' END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'deduction_day','')::integer END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'next_deduction_date','')::date END,
    'self_support',
    CASE WHEN v_self THEN v_uid ELSE NULL END
  ) RETURNING * INTO v_note;

  INSERT INTO public.promissory_note_house_intents (
    note_id, house_id, agent_id, listing_agent_id, monthly_rent, reserved_until, promised_funding_date
  )
  SELECT v_note.id, h.id, v_uid, h.agent_id, COALESCE(h.monthly_rent, 0), v_hold, v_promised
  FROM public.house_listings h
  WHERE h.id = ANY(v_ids)
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(monthly_rent), 0) INTO v_count, v_rent_sum
  FROM public.promissory_note_house_intents
  WHERE note_id = v_note.id AND status = 'reserved';

  IF v_count <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some selected houses are no longer empty. Refresh and try again.' USING ERRCODE = '23514';
  END IF;

  PERFORM public.psm_queue_promissory_pledge_notice(v_note.id);
  PERFORM public.psm_queue_house_booking_notice(v_note.id, 'booked');

  RETURN jsonb_build_object(
    'house_count', v_count,
    'houses_monthly_rent', v_rent_sum,
    'reserved_until', v_hold,
    'promised_funding_date', v_promised
  ) || public._promissory_note_rate_json(v_note, v_uid);
END;
$function$
;


-- ---------------------------------------------------------------------------
-- agent_create_promissory_notes_split (NEW): a split booking - one note per house, each for that
-- house's monthly rent - in ONE call and ONE transaction (all or nothing). It replaces the screen's
-- loop of one RPC plus two edge calls per house. Each house goes through
-- agent_create_promissory_note_for_houses, so every check lives in one place.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_create_promissory_notes_split(p_payload jsonb, p_house_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
  v_house record;
  v_res jsonb;
  v_notes jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_constraint text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  SELECT array_agg(DISTINCT h) INTO v_ids FROM unnest(COALESCE(p_house_ids, '{}'::uuid[])) h WHERE h IS NOT NULL;
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'HOUSES_REQUIRED: select at least one empty house for this partner.' USING ERRCODE = '23514';
  END IF;
  IF array_length(v_ids, 1) > 25 THEN
    RAISE EXCEPTION 'TOO_MANY_HOUSES: split at most 25 houses at a time.' USING ERRCODE = '22023';
  END IF;

  -- One note per house for its rent. Houses are booked in one fixed order (by id), so two
  -- bookings that share houses cannot deadlock; the notes come back in the order the screen sent.
  BEGIN
    FOR v_house IN
      SELECT f.house_id, COALESCE(h.monthly_rent, 0) AS rent
        FROM (SELECT DISTINCT x.house_id FROM unnest(p_house_ids) AS x(house_id)
               WHERE x.house_id IS NOT NULL) f
        JOIN public.house_listings h ON h.id = f.house_id
       ORDER BY f.house_id
    LOOP
      v_res := public.agent_create_promissory_note_for_houses(
                 p_payload || jsonb_build_object('amount', v_house.rent), ARRAY[v_house.house_id]);
      v_notes := v_notes || jsonb_build_array(v_res || jsonb_build_object('house_id', v_house.house_id));
      v_total := v_total + v_house.rent;
    END LOOP;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'ux_pnhi_house_reserved' THEN
      RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some selected houses were just booked by someone else. Refresh and try again.'
        USING ERRCODE = '23514';
    END IF;
    RAISE;
  END;

  SELECT COALESCE(jsonb_agg(e ORDER BY array_position(p_house_ids, (e ->> 'house_id')::uuid)), '[]'::jsonb)
    INTO v_notes FROM jsonb_array_elements(v_notes) e;

  IF jsonb_array_length(v_notes) <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some selected houses are no longer listed. Refresh and try again.' USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'notes', v_notes,
    'note_ids', (SELECT jsonb_agg(n -> 'note' -> 'id') FROM jsonb_array_elements(v_notes) n),
    'house_count', jsonb_array_length(v_notes),
    'total_amount', v_total);
END;
$function$
;
REVOKE ALL ON FUNCTION public.agent_create_promissory_notes_split(jsonb, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_create_promissory_notes_split(jsonb, uuid[]) TO authenticated, service_role;


-- ---------------------------------------------------------------------------
-- psm_queue_house_booking_notice: the queued notice keeps the note's rate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.psm_queue_house_booking_notice(p_note_id uuid, p_kind text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_note public.promissory_notes;
  v_count integer := 0;
  v_rent numeric := 0;
  v_release timestamptz;
  v_promised date;
  v_houses jsonb := '[]'::jsonb;
  v_to record;
  v_rate numeric;
BEGIN
  SELECT * INTO v_note FROM public.promissory_notes WHERE id = p_note_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_rate := v_note.return_rate;
  SELECT c.phone, c.email INTO v_to FROM public._promissory_note_notice_contacts(v_note) c;

  SELECT COUNT(*), COALESCE(SUM(i.monthly_rent),0), MIN(i.reserved_until), MIN(i.promised_funding_date),
         COALESCE(jsonb_agg(jsonb_build_object(
           'house_id', i.house_id,
           'title', COALESCE(h.title, 'Empty house'),
           'district', COALESCE(h.district, h.region, ''),
           'monthly_rent', i.monthly_rent
         ) ORDER BY i.monthly_rent DESC), '[]'::jsonb)
    INTO v_count, v_rent, v_release, v_promised, v_houses
    FROM public.promissory_note_house_intents i
    LEFT JOIN public.house_listings h ON h.id = i.house_id
   WHERE i.note_id = p_note_id
     AND i.status = CASE p_kind
                      WHEN 'funded' THEN 'funded'
                      WHEN 'released' THEN 'released'
                      WHEN 'given_up' THEN 'released'
                      ELSE 'reserved'
                    END;

  IF COALESCE(v_count,0) = 0 THEN RETURN; END IF;

  -- Phase 4 (§2.7 #3): a 'funded' notice states the rate of the houses the person funded (their
  -- supported-house rows), not the note's. Houses at different rates -> NULL (the email hides the % line).
  IF p_kind = 'funded' THEN
    SELECT CASE WHEN count(DISTINCT h.monthly_rate) = 1 THEN min(h.monthly_rate) END INTO v_rate
      FROM public.promissory_note_house_intents i
      JOIN public.partner_supported_houses h ON h.house_id = i.house_id
           AND h.partner_id = v_note.partner_user_id AND h.cancelled_at IS NULL
     WHERE i.note_id = p_note_id AND i.status = 'funded';
  END IF;

  INSERT INTO public.promissory_house_booking_notices (
    note_id, partner_user_id, kind, partner_name, phone, email,
    house_count, total_rent, promised_funding_date, release_at, days_left, houses, return_rate
  ) VALUES (
    p_note_id, v_note.partner_user_id, p_kind, v_note.partner_name,
    v_to.phone, v_to.email,
    v_count, v_rent, v_promised, v_release,
    CASE WHEN v_release IS NULL THEN NULL
         ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_release - now())) / 86400))::int END,
    v_houses, v_rate
  )
  ON CONFLICT (note_id, kind) DO NOTHING;
END;
$function$
;


-- ---------------------------------------------------------------------------
-- A promissory note linked to its person only after the fact.
--   * A note written after the cut-off for someone not yet known carries the new-partner rate
--     (basis 'new'). Once the person is known (and the switch is on) it shows that person's own
--     rate - never lower.
--   * A note that existed at the cut-off has a frozen window (partner_return_note_windows). If it
--     is linked late, the portfolios its person opened after the cut-off INSIDE that window at a
--     lower rate are sent to the CFO (source note_late_link); an approved catch-up then counts
--     like a note-funded portfolio. Their future portfolios already get the note's rate from
--     the rule while the window is open.
-- One statement-level trigger with transition tables: one decision query per linking statement,
-- whatever the number of notes (registration links all of a person's notes in one UPDATE).
-- Linking runs through owner-run code: the note insert's phone match, signup and profile
-- phone/email changes (profile triggers), and the staff arrival match. A browser cannot set
-- promissory_notes.partner_user_id itself after the cut-off (Phase 1 guard).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_note_linked_late()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pol      public.partner_return_policy%ROWTYPE;
  v_queued   integer := 0;
  v_people   integer := 0;
  v_missed   integer := 0;
  v_n        integer;
  v_linked   uuid[];
  v_lock     uuid[];
  v_ids      uuid[];
  v_rates    numeric[];
  v_todo     uuid[];
  v_todo_rates    numeric[];
  v_todo_in_force numeric[];
  v_done     uuid[] := '{}'::uuid[];
  v_held     uuid[];
  v_busy     integer := 0;
  v_text     text;
BEGIN
  SELECT * INTO v_pol FROM public.partner_return_policy p WHERE p.id;
  IF v_pol.cutoff_at IS NULL THEN
    RETURN NULL;                                    -- before the first switch-on: nothing to catch up
  END IF;
  -- Notes this statement linked to a person (or moved to another one). A set operation, not a join:
  -- transition tables have no statistics, so a join is planned as a nested loop (rows x rows).
  SELECT array_agg(d.id) INTO v_linked
    FROM (SELECT n.id, n.partner_user_id FROM new_notes n WHERE n.partner_user_id IS NOT NULL
          EXCEPT
          SELECT o.id, o.partner_user_id FROM old_notes o) d;
  IF v_linked IS NULL THEN
    RETURN NULL;                                    -- this statement linked nobody
  END IF;

  -- Locks, in the order production code already takes them (the split and lock tools hold a
  -- portfolio, then open one, which takes the rate lock):
  --   round 1: the portfolios step 2 may queue (KEY SHARE, id order), then the linked people's rate
  --            lock (partner_rate_lock, the one the gate takes). A portfolio being opened for the
  --            same person right now either sees this link or is seen in round 2.
  --   round 2: the same look-up again, now that the rate lock is held. It never waits for a portfolio
  --            (SKIP LOCKED): one first seen now may be held FOR UPDATE by a split or lock tool that is
  --            itself waiting for this rate lock. Such a busy portfolio is left out and counted in the
  --            alert. Round-1 rows are already held by this transaction, so they are never skipped.
  -- The KEY SHARE matters because the request inserted in step 2 checks its portfolio reference only
  -- at COMMIT (deferred): a staff rate change holding that portfolio (FOR UPDATE, then the
  -- one-open-request slot) would otherwise deadlock with that check. A change already in flight is
  -- waited for here and then seen in step 2.
  FOR v_round IN 1..2 LOOP
    SELECT array_agg(t.id ORDER BY t.id), array_agg(t.note_rate ORDER BY t.id)
      INTO v_ids, v_rates
      FROM (
        SELECT ip.id, max(w.return_rate) AS note_rate
          FROM new_notes n
          JOIN public.partner_return_note_windows w ON w.note_id = n.id
          JOIN public.investor_portfolios ip ON ip.investor_id = n.partner_user_id
         WHERE n.id = ANY (v_linked)
           AND n.status IN ('pending', 'activated', 'fulfilled')
           AND public.partner_note_window_applies(w.partner_user_id, w.agent_id, n.agent_id, n.partner_user_id)
           AND ip.rate_decided_at >= v_pol.cutoff_at
           AND (ip.rate_decided_at AT TIME ZONE 'Africa/Kampala')::date <= w.ends_on
           AND (ip.status = ANY (public.partner_live_portfolio_statuses())
                OR ip.status IN ('pending_ops_approval', 'awaiting_partner_details'))
           AND ip.roi_percentage < w.return_rate
         GROUP BY ip.id
      ) t;
    IF v_ids IS NOT NULL AND v_round = 1 THEN
      PERFORM 1 FROM public.investor_portfolios ip WHERE ip.id = ANY (v_ids) ORDER BY ip.id FOR KEY SHARE;
    ELSIF v_ids IS NOT NULL THEN
      SELECT array_agg(k.id ORDER BY k.id) INTO v_held
        FROM (SELECT ip.id FROM public.investor_portfolios ip WHERE ip.id = ANY (v_ids)
               ORDER BY ip.id FOR KEY SHARE SKIP LOCKED) k;
      -- Busy = skipped AND not already covered by an open request at or above the note's rate (a
      -- plain read, never waits). The busy transaction's own uncommitted change is not seen: one that
      -- adds a covering request is still reported; one that replaces it with a lower rate is not, which
      -- ends as if that change had come after this link (a lower staff request after a link stands).
      SELECT count(*) INTO v_busy
        FROM unnest(v_ids, v_rates) AS x(id, r)
       WHERE NOT (x.id = ANY (COALESCE(v_held, '{}'::uuid[])))
         AND NOT EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                          WHERE a.portfolio_id = x.id
                            AND (a.status = 'pending' OR (a.status = 'approved' AND a.applied_at IS NULL))
                            AND a.requested_rate >= x.r);
      SELECT array_agg(x.id ORDER BY x.id), array_agg(x.r ORDER BY x.id) INTO v_ids, v_rates
        FROM unnest(v_ids, v_rates) AS x(id, r) WHERE x.id = ANY (v_held);
    END IF;
    EXIT WHEN v_round = 2;
    -- The rate lock only for people for whom a linked note opens a pre-cut-off window today: only for
    -- them can a portfolio being opened right now take (or miss) the note's rate. A note written after
    -- the cut-off, or whose frozen window has closed, changes no portfolio decision (step 1 re-stamps
    -- notes, it decides no portfolio rate), so a bulk link (a profile phone or email backfill) does not
    -- hold every linked person's lock bucket, and stall their portfolio creation, until it commits.
    -- None: the portfolios found in round 1 are already held, so round 2 is not needed.
    SELECT array_agg(DISTINCT n.partner_user_id) INTO v_lock
      FROM new_notes n
      JOIN public.partner_return_note_windows w ON w.note_id = n.id
     WHERE n.id = ANY (v_linked)
       AND public.partner_note_window_open(n.status, w.ends_on, w.partner_user_id, w.agent_id, n.agent_id, n.partner_user_id);
    EXIT WHEN v_lock IS NULL;
    PERFORM public.partner_rate_lock(v_lock);
  END LOOP;

  -- 1. Notes written for an unknown person now show that person's own rate (never lower).
  IF v_pol.enabled THEN
    WITH linked AS (
      SELECT n.id, n.partner_user_id
        FROM new_notes n
       WHERE n.id = ANY (v_linked)
         AND n.return_rate_basis = 'new'
    ), r AS (
      SELECT x.partner_id, x.rate, x.basis
        FROM public.partner_rates_for((SELECT array_agg(DISTINCT l.partner_user_id) FROM linked l), false) x
    )
    UPDATE public.promissory_notes pn
       SET return_rate = r.rate, return_rate_basis = r.basis
      FROM linked l JOIN r ON r.partner_id = l.partner_user_id
     WHERE pn.id = l.id
       AND r.rate > pn.return_rate;
  END IF;

  -- 2. Pre-cut-off notes linked late: the person's portfolios opened after the cut-off inside a
  --    note's window at a lower rate wait for the CFO (source note_late_link). An open request at or
  --    above the note's rate stands; a lower one is replaced, as the gate does. A request opened for
  --    the same portfolio by another transaction at this moment (a plain rate edit is not held off by
  --    KEY SHARE) makes the insert skip that portfolio; the second pass sees it committed and applies
  --    the same rule. Anything still refused after that is counted in the alert, never dropped
  --    silently. The link itself never fails because of it.
  IF v_ids IS NOT NULL THEN
    FOR v_round IN 1..2 LOOP
      SELECT array_agg(x.id ORDER BY x.id), array_agg(x.note_rate ORDER BY x.id), array_agg(ip.roi_percentage ORDER BY x.id)
        INTO v_todo, v_todo_rates, v_todo_in_force
        FROM unnest(v_ids, v_rates) AS x(id, note_rate)
        JOIN public.investor_portfolios ip ON ip.id = x.id
       WHERE NOT (x.id = ANY (v_done))
         AND ip.roi_percentage < x.note_rate
         AND NOT EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                          WHERE a.portfolio_id = x.id
                            AND (a.status = 'pending' OR (a.status = 'approved' AND a.applied_at IS NULL))
                            AND a.requested_rate >= x.note_rate);
      v_missed := COALESCE(cardinality(v_todo), 0);
      EXIT WHEN v_todo IS NULL;

      -- Lower open requests are locked in id order first, as the CFO decision locks them (no deadlock
      -- with a CFO batch), and only requests below the note's rate are replaced: one at or above it
      -- that committed since the look-up stands.
      PERFORM 1 FROM public.portfolio_rate_approvals a
        JOIN unnest(v_todo, v_todo_rates) AS t(id, note_rate) ON t.id = a.portfolio_id
       WHERE (a.status = 'pending' OR (a.status = 'approved' AND a.applied_at IS NULL))
         AND a.requested_rate < t.note_rate
       ORDER BY a.id FOR UPDATE OF a;
      UPDATE public.portfolio_rate_approvals a
         SET status = 'superseded', decided_at = COALESCE(a.decided_at, now()),
             decision_note = concat_ws(' · ', a.decision_note, 'Superseded: promissory note linked late')
        FROM unnest(v_todo, v_todo_rates) AS t(id, note_rate)
       WHERE a.portfolio_id = t.id
         AND a.requested_rate < t.note_rate
         AND (a.status = 'pending' OR (a.status = 'approved' AND a.applied_at IS NULL));

      WITH ins AS (
        INSERT INTO public.portfolio_rate_approvals
          (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
        SELECT x.id, x.note_rate, x.in_force, x.note_rate, 'note_late_link', auth.uid()
          FROM unnest(v_todo, v_todo_rates, v_todo_in_force) AS x(id, note_rate, in_force)
         -- An open request at or above the note's rate that was scheduled since the look-up stands
         -- (a pending note request beside a scheduled one would block the CFO's approval).
         WHERE NOT EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                            WHERE a.portfolio_id = x.id
                              AND (a.status = 'pending' OR (a.status = 'approved' AND a.applied_at IS NULL))
                              AND a.requested_rate >= x.note_rate)
        ON CONFLICT (portfolio_id) WHERE status = 'pending' DO NOTHING
        RETURNING portfolio_id)
      SELECT v_done || COALESCE(array_agg(ins.portfolio_id), '{}'::uuid[]), count(*)
        INTO v_done, v_n FROM ins;
      v_missed := v_missed - v_n;
    END LOOP;

    SELECT count(*), count(DISTINCT ip.investor_id) INTO v_queued, v_people
      FROM public.investor_portfolios ip WHERE ip.id = ANY (v_done);
  END IF;

  v_missed := v_missed + v_busy;
  IF v_queued > 0 OR v_missed > 0 THEN
    v_text := CASE WHEN v_queued > 0 THEN
                v_queued || ' portfolio(s) of ' || v_people || ' partner(s) were opened inside a promissory '
                || 'note''s window at a lower rate, before the note was linked to them. Each is waiting in the '
                || 'CFO queue (source note_late_link); nothing changes until the CFO approves.'
              END;
    IF v_missed > 0 THEN
      v_text := concat_ws(' ', v_text,
                  v_missed || ' portfolio(s) could not be queued because another change to the same portfolio '
                  || 'was in progress at the same moment. Check them in the CFO queue against the '
                  || 'promissory note''s rate.');
    END IF;
    PERFORM public._partner_return_alert(
      CASE WHEN v_queued > 0 THEN 'Promissory note linked late: Returns catch-up waiting for the CFO'
           ELSE 'Promissory note linked late: Returns catch-up needs a check' END,
      v_text,
      'note_late_link:' || txid_current()::text);
  END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.partner_note_linked_late() FROM PUBLIC, anon, authenticated;

-- CREATE OR REPLACE keeps a re-apply at the SHARE ROW EXCLUSIVE lock taken above (DROP would
-- take ACCESS EXCLUSIVE midway).
CREATE OR REPLACE TRIGGER trg_zz_partner_note_linked_late
  AFTER UPDATE ON public.promissory_notes
  REFERENCING OLD TABLE AS old_notes NEW TABLE AS new_notes
  FOR EACH STATEMENT EXECUTE FUNCTION public.partner_note_linked_late();


-- ===========================================================================
-- D. Quotes and notices. A figure for a known portfolio uses its stored rate; an offer, a share
--    link or a calculator uses the public new-partner rate (15 while the switch is off, 10 after).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- enqueue_funder_house_notice: "about UGX X a month" from the house's (or commitment's) stored
-- rate, not a fixed 15%. With no stored rate the message gives no figure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_funder_house_notice(p_dedupe_key text, p_kind text, p_partner_id uuid, p_supported_house_id uuid, p_house_id uuid, p_commitment_id uuid, p_house_title text, p_district text, p_house_count integer, p_monthly_rent numeric, p_principal numeric, p_agent_name text, p_placed_at timestamp with time zone, p_earning_started_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profile record;
  v_rate numeric;
  v_monthly_return numeric;
  v_title text;
  v_message text;
  v_house text := COALESCE(NULLIF(p_house_title, ''), 'your funded house');
  v_id uuid;
BEGIN
  IF p_partner_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(
           (SELECT h.monthly_rate FROM public.partner_supported_houses h WHERE h.id = p_supported_house_id),
           (SELECT c.monthly_rate FROM public.partner_self_commitments c WHERE c.id = p_commitment_id))
    INTO v_rate;
  v_monthly_return := CASE WHEN v_rate IS NULL THEN NULL ELSE round(COALESCE(p_principal, 0) * v_rate / 100) END;

  SELECT full_name, email, phone INTO v_profile
  FROM public.profiles WHERE id = p_partner_id;

  INSERT INTO public.funder_house_progress_notices (
    dedupe_key, kind, partner_id, supported_house_id, house_id, commitment_id,
    partner_name, email, phone, house_title, district, house_count,
    monthly_rent, principal, monthly_return, return_rate, agent_name, placed_at, earning_started_at
  ) VALUES (
    p_dedupe_key, p_kind, p_partner_id, p_supported_house_id, p_house_id, p_commitment_id,
    v_profile.full_name, v_profile.email, v_profile.phone, p_house_title, p_district,
    GREATEST(COALESCE(p_house_count, 1), 1), COALESCE(p_monthly_rent, 0),
    COALESCE(p_principal, 0), COALESCE(v_monthly_return, 0), v_rate, p_agent_name, p_placed_at, p_earning_started_at
  )
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN; END IF;

  IF p_kind = 'agent_assigned' THEN
    v_title := 'A Welile agent is on your house';
    v_message := COALESCE(NULLIF(p_agent_name, ''), 'A Welile agent')
      || ' has been assigned to ' || v_house
      || ' and is sourcing a tenant. Tenants are placed within 7 days of funding.';
  ELSIF p_kind = 'tenant_placed' THEN
    v_title := 'Tenant placed in your house';
    v_message := 'A tenant has moved into ' || v_house
      || '. Your Returns start as soon as the tenant begins paying rent.';
  ELSE
    v_title := 'Your Returns have started';
    v_message := CASE WHEN v_monthly_return IS NULL
      THEN 'Your money is now working. Your Returns are paid into your Welile wallet.'
      ELSE 'Your money is now working. You are earning about UGX '
        || to_char(v_monthly_return, 'FM999,999,999,999')
        || ' a month in Returns, paid into your Welile wallet.' END;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, event_key, link_path, metadata)
  VALUES (
    p_partner_id, v_title, v_message, 'success', p_dedupe_key, '/dashboard/funder',
    jsonb_build_object('kind', p_kind, 'house_id', p_house_id, 'supported_house_id', p_supported_house_id)
  )
  ON CONFLICT DO NOTHING;

  -- Wake the worker for this row only. Never fatal to the caller.
  BEGIN
    PERFORM net.http_post(
      url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/notify-funder-house-progress',
      headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5cnpzaHdsZW50cXZrdGNrc2VtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4OTI3MTQsImV4cCI6MjEwNzQ2ODcxNH0.8oMYC39wCMHtVlevN1D8rQnIZgtcwJVpG6z3QnTXnAs"}'::jsonb,
      body := jsonb_build_object('notice_id', v_id)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$function$
;


-- ---------------------------------------------------------------------------
-- get_or_create_house_share_link: share text quotes the public new-partner rate. The text is
-- fingerprinted, so links refresh their preview the next time they are shared after a change.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_or_create_house_share_link(p_house_id uuid)
 RETURNS TABLE(code text, og_title text, og_description text, og_image_url text, destination_path text, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_row public.short_links;
  v_created boolean := false;
  v_h public.house_listings;
  v_image text;
  v_title text;
  v_desc text;
  v_dest text := '/support-house';
  v_fp text;
  v_place text;
  v_cat text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Sign in to share this house';
  END IF;

  SELECT * INTO v_h FROM public.house_listings WHERE id = p_house_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HOUSE_NOT_FOUND';
  END IF;

  v_cat := NULLIF(btrim(initcap(replace(COALESCE(v_h.house_category, ''), '_', ' '))), '');
  v_place := NULLIF(btrim(concat_ws(', ', NULLIF(v_h.village,''), NULLIF(v_h.sub_county,''), NULLIF(v_h.district,''))), '');
  v_title := COALESCE(NULLIF(btrim(v_h.title), ''), COALESCE(v_cat, 'Empty house'))
             || ' in ' || COALESCE(v_place || ', Uganda', 'Uganda') || ' | Welile';
  v_desc := 'Support this available house through Welile. Pay one month''s rent of UGX '
            || to_char(round(COALESCE(v_h.monthly_rent,0)), 'FM999,999,999')
            || ' and receive UGX ' || to_char(round(COALESCE(v_h.monthly_rent,0) * public.partner_new_contract_rate() / 100), 'FM999,999,999')
            || ' every month for the next 12 months. A family moves in as soon as it is supported.';

  SELECT u INTO v_image
  FROM unnest(COALESCE(v_h.image_urls, ARRAY[]::text[])) u
  WHERE u IS NOT NULL AND u <> '' AND u ILIKE 'https://%'
  LIMIT 1;

  v_fp := md5(COALESCE(v_image,'') || '|' || v_title || '|' || v_desc);

  SELECT * INTO v_row FROM public.short_links s
   WHERE s.user_id = v_user AND s.resource_type = 'house_support' AND s.resource_id = p_house_id
   LIMIT 1;

  IF v_row.id IS NULL THEN
    BEGIN
      INSERT INTO public.short_links (
        user_id, target_path, target_params, resource_type, resource_id,
        og_title, og_description, og_image_url, og_image_fingerprint, og_updated_at, destination_path
      ) VALUES (
        v_user, v_dest, '{}'::jsonb, 'house_support', p_house_id,
        v_title, v_desc, v_image, v_fp, now(), v_dest
      ) RETURNING * INTO v_row;
      v_created := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_row FROM public.short_links s
       WHERE s.user_id = v_user AND s.resource_type = 'house_support' AND s.resource_id = p_house_id
       LIMIT 1;
    END;
  END IF;

  IF v_row.id IS NOT NULL AND (COALESCE(v_row.target_params->>'s','') <> v_row.code
      OR COALESCE(v_row.og_image_fingerprint,'') <> v_fp) THEN
    UPDATE public.short_links s
       SET target_params = jsonb_build_object('s', s.code),
           target_path = v_dest,
           destination_path = v_dest,
           og_title = v_title,
           og_description = v_desc,
           og_image_url = v_image,
           og_image_fingerprint = v_fp,
           og_updated_at = now()
     WHERE s.id = v_row.id
     RETURNING * INTO v_row;
  END IF;

  RETURN QUERY SELECT v_row.code, v_row.og_title, v_row.og_description,
                      v_row.og_image_url, COALESCE(v_row.destination_path, v_row.target_path), v_created;
END;
$function$
;


-- ---------------------------------------------------------------------------
-- get_supporter_pool_stats (manager card on the old supporter pool): the monthly obligation is
-- weighted by the rate behind each contribution instead of a fixed 15%. Money put in before the
-- cut-off is at the legacy rate; money put in after it at the contributor's own rate (one rule
-- call for all contributors). With the switch off, or before the cut-off, it equals today's figure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_supporter_pool_stats()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  total_in numeric;
  total_out numeric;
  total_withdrawn numeric;
  v_rate numeric;
begin /* advisor_guard */ if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then raise exception 'not authorized' using errcode = '42501'; end if;
  SELECT COALESCE(SUM(amount), 0) INTO total_in
  FROM general_ledger WHERE category = 'supporter_rent_fund';

  SELECT COALESCE(SUM(amount), 0) INTO total_out
  FROM general_ledger WHERE category = 'pool_rent_deployment';

  SELECT COALESCE(SUM(amount), 0) INTO total_withdrawn
  FROM general_ledger WHERE category = 'supporter_capital_return';

  WITH pol AS (SELECT p.legacy_rate, p.cutoff_at FROM public.partner_return_policy p WHERE p.id),
  contrib AS (
    SELECT g.user_id, g.amount,
           (pol.cutoff_at IS NOT NULL AND g.transaction_date >= pol.cutoff_at) AS after_cutoff
      FROM general_ledger g, pol WHERE g.category = 'supporter_rent_fund'
  ),
  rates AS (
    SELECT r.partner_id, r.rate
      FROM public.partner_rates_for((SELECT array_agg(DISTINCT x.user_id) FROM contrib x WHERE x.after_cutoff), true) r
  )
  SELECT sum(x.amount * CASE WHEN x.after_cutoff THEN COALESCE(rt.rate, pol.legacy_rate) ELSE pol.legacy_rate END)
         / NULLIF(sum(x.amount), 0)
    INTO v_rate
    FROM contrib x CROSS JOIN pol LEFT JOIN rates rt ON rt.partner_id = x.user_id;
  v_rate := COALESCE(v_rate, (SELECT p.legacy_rate FROM public.partner_return_policy p WHERE p.id));

  RETURN json_build_object(
    'poolBalance', total_in - total_out,
    'totalDeployed', total_out,
    'monthlyObligation', ROUND((total_in - total_withdrawn) * v_rate / 100),
    'deployableAmount', GREATEST(0, (total_in - total_out) - ROUND((total_in - total_withdrawn) * v_rate / 100)),
    'obligationRatePct', trim_scale(round(v_rate, 2))
  );
END;
$function$
;


-- ---------------------------------------------------------------------------
-- agent_list_empty_house_opportunities: the caller says who the figures are for
-- (p_quote_for: public | me | partner + p_partner_id, staff only); decided ONCE per call.
-- The signature grows, so the old one is dropped and execute is granted again.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.agent_list_empty_house_opportunities(text, integer, integer, text, boolean, boolean, numeric, numeric, double precision, double precision, double precision, text);
CREATE OR REPLACE FUNCTION public.agent_list_empty_house_opportunities(p_search text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0, p_district text DEFAULT NULL::text, p_verified_only boolean DEFAULT false, p_gps_only boolean DEFAULT false, p_min_rent numeric DEFAULT NULL::numeric, p_max_rent numeric DEFAULT NULL::numeric, p_near_lat double precision DEFAULT NULL::double precision, p_near_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision, p_sort text DEFAULT NULL::text, p_quote_for text DEFAULT 'public'::text, p_partner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_district text := NULLIF(btrim(COALESCE(p_district, '')), '');
  v_radius double precision := NULLIF(COALESCE(p_radius_km, 0), 0);
  v_sort text := lower(NULLIF(btrim(COALESCE(p_sort, '')), ''));
  v_dlat double precision;
  v_dlng double precision;
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_rate numeric := public.partner_quote_rate(p_quote_for, p_partner_id);
  v_districts jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.has_role(v_uid, 'supporter')
    OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  IF v_sort IS NULL OR v_sort NOT IN ('recommended', 'nearest', 'newest', 'rent_high', 'rent_low') THEN
    v_sort := 'recommended';
  END IF;

  IF v_sort = 'nearest' AND (p_near_lat IS NULL OR p_near_lng IS NULL) THEN
    v_sort := 'recommended';
  END IF;

  IF v_radius IS NOT NULL AND p_near_lat IS NOT NULL AND p_near_lng IS NOT NULL THEN
    v_dlat := v_radius / 111.0;
    v_dlng := v_radius / GREATEST(cos(radians(p_near_lat)) * 111.0, 0.000001);
  END IF;

  WITH base AS (
    SELECT
      h.id,
      h.verified,
      h.created_at,
      COALESCE(h.monthly_rent, 0) AS monthly_rent,
      CASE
        WHEN p_near_lat IS NULL OR p_near_lng IS NULL
          OR h.latitude IS NULL OR h.longitude IS NULL THEN NULL
        ELSE sqrt(
          pow((h.latitude - p_near_lat) * 111.0, 2)
          + pow((h.longitude - p_near_lng) * cos(radians(p_near_lat)) * 111.0, 2)
        )
      END AS distance_km
    FROM public.house_listings h
    LEFT JOIN public.landlords lp ON lp.id = h.landlord_id
    LEFT JOIN public.profiles ap ON ap.id = h.agent_id
    WHERE h.status = 'available'
      AND h.tenant_id IS NULL
      AND COALESCE(h.is_hidden, false) = false
      AND COALESCE(h.monthly_rent, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM public.promissory_note_house_intents pni
                       WHERE pni.house_id = h.id AND pni.status IN ('reserved','funded'))
      AND NOT EXISTS (SELECT 1 FROM public.partner_supported_houses pshc
                       WHERE pshc.house_id = h.id AND pshc.status IN ('pending','active'))
      AND NOT EXISTS (SELECT 1 FROM public.portfolio_allocations pa
                       WHERE pa.house_id = h.id AND pa.status IN ('reserved','fulfilled'))
      AND (
        v_search IS NULL
        OR h.title ILIKE '%' || v_search || '%'
        OR h.district ILIKE '%' || v_search || '%'
        OR h.sub_county ILIKE '%' || v_search || '%'
        OR h.village ILIKE '%' || v_search || '%'
        OR h.region ILIKE '%' || v_search || '%'
        OR lp.name ILIKE '%' || v_search || '%'
        OR lp.phone ILIKE '%' || v_search || '%'
        OR ap.full_name ILIKE '%' || v_search || '%'
      )
      AND (v_district IS NULL OR h.district ILIKE v_district)
      AND (COALESCE(p_verified_only, false) = false OR COALESCE(h.verified, false) = true)
      AND (
        COALESCE(p_gps_only, false) = false
        OR (h.latitude IS NOT NULL AND h.longitude IS NOT NULL AND (h.latitude <> 0 OR h.longitude <> 0))
      )
      AND (p_min_rent IS NULL OR COALESCE(h.monthly_rent, 0) >= p_min_rent)
      AND (p_max_rent IS NULL OR COALESCE(h.monthly_rent, 0) <= p_max_rent)
      AND (
        v_dlat IS NULL
        OR (
          h.latitude IS NOT NULL AND h.longitude IS NOT NULL
          AND h.latitude BETWEEN p_near_lat - v_dlat AND p_near_lat + v_dlat
          AND h.longitude BETWEEN p_near_lng - v_dlng AND p_near_lng + v_dlng
        )
      )
  ),
  counted AS (SELECT COUNT(*) AS c FROM base),
  page AS (
    SELECT
      b.id,
      b.distance_km,
      row_number() OVER (
        ORDER BY
          CASE WHEN v_sort = 'nearest' THEN b.distance_km END ASC NULLS LAST,
          CASE WHEN v_sort = 'newest' THEN b.created_at END DESC NULLS LAST,
          CASE WHEN v_sort = 'rent_high' THEN b.monthly_rent END DESC NULLS LAST,
          CASE WHEN v_sort = 'rent_low' THEN b.monthly_rent END ASC NULLS LAST,
          CASE WHEN v_sort = 'recommended' THEN (CASE WHEN b.verified THEN 0 ELSE 1 END) END ASC NULLS LAST,
          b.created_at DESC
      ) AS rn
    FROM base b
    ORDER BY rn
    LIMIT v_limit OFFSET v_offset
  ),
  rows_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'house_id', h.id,
      'title', h.title,
      'house_category', h.house_category,
      'monthly_rent', COALESCE(h.monthly_rent, 0),
      'district', h.district,
      'sub_county', h.sub_county,
      'village', h.village,
      'region', h.region,
      'number_of_rooms', h.number_of_rooms,
      'verified', COALESCE(h.verified, false),
      'listing_agent_id', h.agent_id,
      'listing_agent_name', p.full_name,
      'image_url', CASE WHEN h.image_urls IS NOT NULL AND array_length(h.image_urls, 1) > 0 THEN h.image_urls[1] ELSE NULL END,
      'image_urls', COALESCE(to_jsonb(h.image_urls), '[]'::jsonb),
      'latitude', h.latitude,
      'longitude', h.longitude,
      'landlord_id', h.landlord_id,
      'landlord_name', lp.name,
      'landlord_phone', lp.phone,
      'distance_km', pg.distance_km,
      'partner_monthly_return', round(COALESCE(h.monthly_rent, 0) * v_rate / 100),
      'partner_annual_return', round(COALESCE(h.monthly_rent, 0) * v_rate / 100 * 12),
      'created_at', h.created_at
    ) ORDER BY pg.rn), '[]'::jsonb) AS j
    FROM page pg
    JOIN public.house_listings h ON h.id = pg.id
    LEFT JOIN public.profiles p ON p.id = h.agent_id
    LEFT JOIN public.landlords lp ON lp.id = h.landlord_id
  )
  SELECT counted.c, rows_json.j INTO v_total, v_rows FROM counted, rows_json;

  SELECT COALESCE(jsonb_agg(q.d ORDER BY q.d), '[]'::jsonb) INTO v_districts
  FROM (
    SELECT DISTINCT btrim(hl.district) AS d
    FROM public.house_listings hl
    WHERE hl.status = 'available'
      AND hl.tenant_id IS NULL
      AND COALESCE(hl.is_hidden, false) = false
      AND COALESCE(hl.monthly_rent, 0) > 0
      AND NULLIF(btrim(COALESCE(hl.district, '')), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.partner_supported_houses psh
        WHERE psh.house_id = hl.id
          AND psh.status IN ('pending', 'active')
      )
  ) q;

  RETURN jsonb_build_object('total', v_total, 'houses', v_rows, 'districts', v_districts,
                            'returns_rate_pct', v_rate);
END;
$function$
;
REVOKE ALL ON FUNCTION public.agent_list_empty_house_opportunities(text, integer, integer, text, boolean, boolean, numeric, numeric, double precision, double precision, double precision, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_list_empty_house_opportunities(text, integer, integer, text, boolean, boolean, numeric, numeric, double precision, double precision, double precision, text, text, uuid) TO authenticated, service_role;


-- ---------------------------------------------------------------------------
-- empty_house_opportunity_summary: same audience parameter as the listing.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.empty_house_opportunity_summary();
CREATE OR REPLACE FUNCTION public.empty_house_opportunity_summary(p_quote_for text DEFAULT 'public'::text, p_partner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH quote AS MATERIALIZED (SELECT public.partner_quote_rate(p_quote_for, p_partner_id) AS rate),
base AS (
  SELECT h.id, COALESCE(h.monthly_rent, 0) AS rent,
         NULLIF(TRIM(COALESCE(h.district, '')), '') AS district,
         h.landlord_id,
         (
           EXISTS (SELECT 1 FROM public.promissory_note_house_intents i
                    WHERE i.house_id = h.id AND i.status IN ('reserved','funded'))
           OR EXISTS (SELECT 1 FROM public.partner_supported_houses psh
                       WHERE psh.house_id = h.id AND psh.status IN ('pending','active'))
           OR EXISTS (SELECT 1 FROM public.portfolio_allocations a
                       WHERE a.house_id = h.id AND a.status IN ('reserved','fulfilled'))
         ) AS is_funded
  FROM public.house_listings h
  WHERE h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden, false) = false
    AND COALESCE(h.monthly_rent, 0) > 0
),
avail AS (SELECT * FROM base WHERE NOT is_funded),
districts AS (
  SELECT jsonb_agg(d ORDER BY (d->>'total_rent_needed')::numeric DESC) AS rows
  FROM (SELECT jsonb_build_object('district', COALESCE(district,'Unspecified'),
          'house_count', COUNT(*), 'total_rent_needed', COALESCE(SUM(rent),0),
          'monthly_return', COALESCE(SUM(ROUND(rent*((SELECT q.rate FROM quote q) / 100))),0)) AS d
        FROM avail GROUP BY COALESCE(district,'Unspecified')
        ORDER BY SUM(rent) DESC LIMIT 12) t
),
landlords AS (
  SELECT jsonb_agg(l ORDER BY (l->>'total_rent_needed')::numeric DESC) AS rows
  FROM (SELECT jsonb_build_object('landlord_name', TRIM(p.name),
          'house_count', COUNT(*), 'total_rent_needed', COALESCE(SUM(a.rent),0),
          'monthly_return', COALESCE(SUM(ROUND(a.rent*((SELECT q.rate FROM quote q) / 100))),0)) AS l
        FROM avail a JOIN public.landlords p ON p.id = a.landlord_id
        WHERE NULLIF(TRIM(COALESCE(p.name,'')),'') IS NOT NULL
        GROUP BY TRIM(p.name) ORDER BY SUM(a.rent) DESC LIMIT 8) t
)
SELECT jsonb_build_object(
  'house_count', (SELECT COUNT(*) FROM avail),
  'total_rent_needed', (SELECT COALESCE(SUM(rent),0) FROM avail),
  'monthly_return_if_all_funded', (SELECT COALESCE(SUM(ROUND(rent*((SELECT q.rate FROM quote q) / 100))),0) FROM avail),
  'avg_monthly_rent', (SELECT COALESCE(ROUND(AVG(rent)),0) FROM avail),
  'funded_count', (SELECT COUNT(*) FROM base WHERE is_funded),
  'funded_rent', (SELECT COALESCE(SUM(rent),0) FROM base WHERE is_funded),
  'total_listed', (SELECT COUNT(*) FROM base),
  'districts', COALESCE((SELECT rows FROM districts),'[]'::jsonb),
  'landlords', COALESCE((SELECT rows FROM landlords),'[]'::jsonb),
  'returns_rate_pct', (SELECT q.rate FROM quote q));
$function$
;
REVOKE ALL ON FUNCTION public.empty_house_opportunity_summary(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.empty_house_opportunity_summary(text, uuid) TO authenticated, service_role;


-- ---------------------------------------------------------------------------
-- get_or_create_plan_share_link: a public page or share text, so the public new-partner rate (read once per query).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_or_create_plan_share_link(p_plan_id uuid)
 RETURNS TABLE(code text, og_title text, og_description text, og_image_url text, destination_path text, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_row public.short_links;
  v_created boolean := false;
  v_rent numeric := 0;
  v_category text;
  v_loc text;
  v_images text[];
  v_image text;
  v_title text;
  v_desc text;
  v_dest text := '/funder-onboarding';
  v_fp text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Sign in to share this plan';
  END IF;

  -- Authoritative plan data (never trust client-supplied preview values).
  SELECT COALESCE(p.funding_amount, 0), p.house_category,
         COALESCE(NULLIF(p.tenant_location, ''), p.request_city), p.house_image_urls
    INTO v_rent, v_category, v_loc, v_images
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = p_plan_id;

  IF NOT FOUND THEN
    SELECT COALESCE(r.rent_amount, 0), r.house_category, r.request_city, r.house_image_urls
      INTO v_rent, v_category, v_loc, v_images
    FROM public.rent_requests r
    WHERE r.id = p_plan_id;
  END IF;

  v_category := NULLIF(btrim(initcap(replace(COALESCE(v_category, ''), '_', ' '))), '');
  v_loc := NULLIF(btrim(COALESCE(v_loc, '')), '');
  v_title := 'Support a tenant in a ' || COALESCE(v_category, 'Rental Home')
             || ' in ' || COALESCE(v_loc || ', Uganda', 'Uganda');
  v_desc := CASE WHEN v_rent > 0 THEN
      'Support this tenant for UGX ' || to_char(round(v_rent), 'FM999,999,999')
      || ' by paying their landlord on the platform and earn UGX '
      || to_char(round(v_rent * ((SELECT public.partner_new_contract_rate()) / 100)), 'FM999,999,999')
      || ' per month for the next 12 months Start here today.'
    ELSE
      'Support a tenant''s rent on Welile and earn monthly returns. Support today.'
    END;

  SELECT u INTO v_image
  FROM unnest(COALESCE(v_images, ARRAY[]::text[])) u
  WHERE u IS NOT NULL AND u <> '' AND u ILIKE 'https://%'
  LIMIT 1;

  v_fp := md5(COALESCE(v_image, '') || '|' || COALESCE(v_title, '') || '|' || COALESCE(v_desc, ''));

  SELECT * INTO v_row FROM public.short_links s
  WHERE s.user_id = v_user AND s.resource_type = 'rent_plan' AND s.resource_id = p_plan_id
  LIMIT 1;

  IF NOT FOUND THEN
    -- Legacy row for the same sharer/plan created before resource tagging.
    SELECT * INTO v_row FROM public.short_links s
    WHERE s.user_id = v_user
      AND s.resource_type IS NULL
      AND s.target_params->>'plan' = p_plan_id::text
    ORDER BY s.created_at
    LIMIT 1;
  END IF;

  IF v_row.id IS NULL THEN
    BEGIN
      INSERT INTO public.short_links (
        user_id, target_path, target_params, resource_type, resource_id,
        og_title, og_description, og_image_url, og_image_fingerprint, og_updated_at, destination_path
      ) VALUES (
        v_user, v_dest,
        jsonb_build_object('plan', p_plan_id::text, 'ref', v_user::text),
        'rent_plan', p_plan_id,
        v_title, v_desc, v_image, v_fp, now(), v_dest
      )
      RETURNING * INTO v_row;
      v_created := true;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent tap inserted first: return that persisted row.
      SELECT * INTO v_row FROM public.short_links s
      WHERE s.user_id = v_user AND s.resource_type = 'rent_plan' AND s.resource_id = p_plan_id
      LIMIT 1;
    END;
  END IF;

  -- Refresh metadata in place only when it actually changed. The id, code and
  -- attribution are never modified.
  IF NOT v_created AND v_row.id IS NOT NULL
     AND COALESCE(v_row.og_image_fingerprint, '') <> v_fp THEN
    UPDATE public.short_links s
    SET resource_type = 'rent_plan',
        resource_id = p_plan_id,
        og_title = v_title,
        og_description = v_desc,
        og_image_url = v_image,
        og_image_fingerprint = v_fp,
        og_updated_at = now(),
        destination_path = COALESCE(s.destination_path, v_dest)
    WHERE s.id = v_row.id
    RETURNING * INTO v_row;
  END IF;

  RETURN QUERY SELECT v_row.code, v_row.og_title, v_row.og_description,
                      v_row.og_image_url, COALESCE(v_row.destination_path, v_row.target_path), v_created;
END;
$function$
;


-- ---------------------------------------------------------------------------
-- public_house_support_offer: a public page or share text, so the public new-partner rate (read once per query).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.public_house_support_offer(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF p_code IS NULL OR btrim(p_code) = '' THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT jsonb_build_object(
    'found', true,
    'share_code', s.code,
    'house_id', h.id,
    'title', COALESCE(NULLIF(btrim(h.title),''), initcap(replace(COALESCE(h.house_category,'Rental home'),'_',' '))),
    'house_category', h.house_category,
    'number_of_rooms', h.number_of_rooms,
    'village', h.village,
    'sub_county', h.sub_county,
    'district', h.district,
    'region', h.region,
    'monthly_rent', COALESCE(h.monthly_rent,0),
    'monthly_return', round(COALESCE(h.monthly_rent,0) * ((SELECT public.partner_new_contract_rate()) / 100)),
    'image_urls', COALESCE(to_jsonb(h.image_urls), '[]'::jsonb),
    'latitude', h.latitude,
    'longitude', h.longitude,
    'verified', COALESCE(h.verified,false),
    'shared_by', COALESCE(NULLIF(split_part(btrim(p.full_name), ' ', 1), ''), 'A Welile agent'),
    'availability', CASE
      WHEN EXISTS (SELECT 1 FROM public.partner_supported_houses ps
                    WHERE ps.house_id = h.id AND ps.status IN ('pending','active')) THEN 'supported'
      WHEN EXISTS (SELECT 1 FROM public.portfolio_allocations pa
                    WHERE pa.house_id = h.id AND pa.status IN ('reserved','fulfilled')) THEN 'supported'
      WHEN EXISTS (SELECT 1 FROM public.promissory_note_house_intents i
                    WHERE i.house_id = h.id AND i.status = 'reserved') THEN 'reserved'
      WHEN h.verified IS NOT TRUE OR h.status <> 'available' OR h.tenant_id IS NOT NULL
           OR COALESCE(h.is_hidden,false) = true OR COALESCE(h.monthly_rent,0) <= 0 THEN 'unavailable'
      ELSE 'available'
    END
  ) INTO v
  FROM public.short_links s
  JOIN public.house_listings h ON h.id = s.resource_id
  LEFT JOIN public.profiles p ON p.id = s.user_id
  WHERE s.code = p_code AND s.resource_type = 'house_support'
  LIMIT 1;

  RETURN COALESCE(v, jsonb_build_object('found', false));
END;
$function$
;


-- ---------------------------------------------------------------------------
-- public_support_plan: a public page or share text, so the public new-partner rate (read once per query).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.public_support_plan(p_plan_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plan public.v_partner_self_fundable_plans%ROWTYPE;
  v_monthly numeric;
BEGIN
  -- Read-only public lookup for shared Support Plan links. Returns ONLY
  -- whitelisted safe fields: house photo, city/area, tenant first name,
  -- support amount, monthly earning at the new-contract rate, 12-month total, funding status.
  -- Never returns phones, full names, IDs, GPS, agent or wallet data.
  SELECT p.*
  INTO v_plan
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = p_plan_id
    AND p.held_by IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;

  v_monthly := ROUND(COALESCE(v_plan.funding_amount, 0) * ((SELECT public.partner_new_contract_rate()) / 100));

  RETURN jsonb_build_object(
    'status', 'available',
    'plan_id', v_plan.rent_request_id,
    'photo_url', CASE
      WHEN v_plan.house_image_urls IS NOT NULL AND array_length(v_plan.house_image_urls, 1) > 0
      THEN v_plan.house_image_urls[1]
      ELSE NULL
    END,
    'city', v_plan.request_city,
    'house_category', v_plan.house_category,
    'tenant_first_name', v_plan.tenant_first_name,
    'funding_amount', v_plan.funding_amount,
    'monthly_return', v_monthly,
    'twelve_month_total', v_monthly * 12
  );
END;
$function$
;


-- ---------------------------------------------------------------------------
-- partner_supported_house_returns (the partner's list of houses booked through promissory notes):
-- each house's Returns come from its note's stamped rate, not a fixed 15%. Every note is 15 while
-- the switch is off, so the figures are unchanged until the first switch-on.
-- ---------------------------------------------------------------------------
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
    -- A note picked up by the caller's email or phone but linked to someone else and stamped with that
    -- person's own rate: not shown (the rule of _promissory_note_rate_json; a 'legacy' note shows 15).
    'return_rate', CASE WHEN n.return_rate_basis = 'legacy' OR (n.partner_user_id IS NULL AND n.return_rate_basis = 'new')
                             OR n.partner_user_id = v_uid THEN trim_scale(n.return_rate) END,
    'monthly_return', CASE WHEN n.return_rate_basis = 'legacy' OR (n.partner_user_id IS NULL AND n.return_rate_basis = 'new')
                                OR n.partner_user_id = v_uid
                           THEN round(COALESCE(i.monthly_rent, h.monthly_rent, 0) * n.return_rate / 100) END,
    'annual_return', CASE WHEN n.return_rate_basis = 'legacy' OR (n.partner_user_id IS NULL AND n.return_rate_basis = 'new')
                               OR n.partner_user_id = v_uid
                          THEN round(COALESCE(i.monthly_rent, h.monthly_rent, 0) * n.return_rate / 100 * 12) END,
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


-- ===========================================================================
-- E. The old rent-facilitation reward (fund-tenants sets rent_requests.supporter_id; the 06:00
--    process-supporter-roi job pays the reward through post_rent_facilitation_reward). Owner
--    decision 2026-11-06: keep the path and make it per person. Each funding stores the
--    supporter's rate once; the reward is paid at that stored rate. Kept in a side table so no
--    rent_requests row is rewritten (that table has dozens of update triggers).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.rent_facilitation_reward_rates (
  rent_request_id uuid PRIMARY KEY,
  supporter_id    uuid NOT NULL,
  rate            numeric(6,2) NOT NULL CHECK (rate > 0 AND rate <= 100),
  basis           text NOT NULL,
  decided_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.rent_facilitation_reward_rates IS
  'Monthly Returns rate of each legacy rent-facilitation funding (rent_requests.supporter_id), decided once by the Partner Returns rule when the supporter is set. Written only by trg_zz_stamp_rent_reward_rate_*; read by post_rent_facilitation_reward.';

ALTER TABLE public.rent_facilitation_reward_rates ENABLE ROW LEVEL SECURITY;
-- Read-only for the service role: written only by the trigger below (SECURITY DEFINER).
REVOKE ALL ON public.rent_facilitation_reward_rates FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.rent_facilitation_reward_rates TO service_role;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.rent_facilitation_reward_rates;
CREATE POLICY mfa_required_for_staff ON public.rent_facilitation_reward_rates AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

-- Fundings made before the first switch-on were made at the legacy rate (at the first apply that is
-- all of them: the switch cannot be on before the release). On a re-apply after the cut-off, a row
-- missing for a funding made after the cut-off, or a row whose supporter has changed since it was
-- stored, is decided by the Partner Returns rule, as the stamp trigger below would have when the
-- supporter was set; a row missing for a funding made before the cut-off keeps the legacy rate.
-- A row already stored for the same supporter is never touched.
WITH pol AS (
  SELECT p.cutoff_at, p.legacy_rate FROM public.partner_return_policy p WHERE p.id
), src AS (
  SELECT rr.id, rr.supporter_id, rr.funded_at,
         (pol.cutoff_at IS NULL
          OR (COALESCE(rr.funded_at, now()) < pol.cutoff_at
              AND NOT EXISTS (SELECT 1 FROM public.rent_facilitation_reward_rates y
                               WHERE y.rent_request_id = rr.id))) AS legacy
    FROM public.rent_requests rr CROSS JOIN pol
   WHERE rr.supporter_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.rent_facilitation_reward_rates x
                      WHERE x.rent_request_id = rr.id AND x.supporter_id = rr.supporter_id)
), dec AS (
  SELECT r.partner_id, r.rate, r.basis
    FROM public.partner_rates_for((SELECT array_agg(DISTINCT s.supporter_id) FROM src s WHERE NOT s.legacy), true) r
)
INSERT INTO public.rent_facilitation_reward_rates (rent_request_id, supporter_id, rate, basis, decided_at)
SELECT s.id, s.supporter_id,
       CASE WHEN s.legacy THEN pol.legacy_rate ELSE d.rate END,
       CASE WHEN s.legacy THEN 'legacy' ELSE d.basis END,
       CASE WHEN s.legacy THEN COALESCE(s.funded_at, now()) ELSE now() END
  FROM src s CROSS JOIN pol LEFT JOIN dec d ON d.partner_id = s.supporter_id
ON CONFLICT (rent_request_id) DO UPDATE
   SET supporter_id = EXCLUDED.supporter_id, rate = EXCLUDED.rate,
       basis = EXCLUDED.basis, decided_at = EXCLUDED.decided_at
 WHERE public.rent_facilitation_reward_rates.supporter_id IS DISTINCT FROM EXCLUDED.supporter_id;

-- A new supporter on a rent request: decide their rate once (a different supporter is decided again).
-- The person's rate lock first, as the gate does: a promissory note being linked to the same person
-- at this moment is either seen here or has not been linked yet. (A note linked after the funding does
-- not raise a stored reward rate; the late-link catch-up covers portfolios only.)
CREATE OR REPLACE FUNCTION public.stamp_rent_facilitation_reward_rate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.partner_rate_lock(ARRAY[NEW.supporter_id]);
  INSERT INTO public.rent_facilitation_reward_rates (rent_request_id, supporter_id, rate, basis, decided_at)
  SELECT NEW.id, NEW.supporter_id, r.rate, r.basis, now()
    FROM public.partner_rates_for(ARRAY[NEW.supporter_id], true) r
  ON CONFLICT (rent_request_id) DO UPDATE
     SET supporter_id = EXCLUDED.supporter_id, rate = EXCLUDED.rate,
         basis = EXCLUDED.basis, decided_at = EXCLUDED.decided_at
   WHERE public.rent_facilitation_reward_rates.supporter_id IS DISTINCT FROM EXCLUDED.supporter_id;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.stamp_rent_facilitation_reward_rate() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_zz_stamp_rent_reward_rate_ins
  AFTER INSERT ON public.rent_requests
  FOR EACH ROW WHEN (NEW.supporter_id IS NOT NULL)
  EXECUTE FUNCTION public.stamp_rent_facilitation_reward_rate();
CREATE OR REPLACE TRIGGER trg_zz_stamp_rent_reward_rate_upd
  AFTER UPDATE OF supporter_id ON public.rent_requests
  FOR EACH ROW WHEN (NEW.supporter_id IS NOT NULL AND NEW.supporter_id IS DISTINCT FROM OLD.supporter_id)
  EXECUTE FUNCTION public.stamp_rent_facilitation_reward_rate();

-- ---------------------------------------------------------------------------
-- post_rent_facilitation_reward: pays the stored rate. No stored rate: refuse (the job logs it and
-- retries next run) rather than guess a number.
-- ---------------------------------------------------------------------------
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
  v_rate numeric;
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

  -- The rate stored when this supporter funded the request (Partner Returns rule).
  SELECT x.rate INTO v_rate FROM public.rent_facilitation_reward_rates x
   WHERE x.rent_request_id = rr.id AND x.supporter_id = rr.supporter_id;
  IF v_rate IS NULL THEN
    RAISE EXCEPTION 'RENT_REWARD_RATE_MISSING: no stored Returns rate for rent request %', rr.id USING ERRCODE = '55000';
  END IF;

  v_amount := round(rr.rent_amount * v_rate / 100);
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
        'description', format('Returns payout #%s auto-reinvested into portfolio', p_payment_number), 'currency', 'UGX', 'transaction_date', v_now),
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_in', 'amount', v_amount, 'category', 'roi_reinvestment',
        'ledger_scope', 'platform', 'source_table', 'investor_portfolios', 'source_id', pf.id, 'linked_party', 'platform',
        'description', format('Auto-reinvested Returns #%s (%s) into portfolio', p_payment_number, to_char(v_amount, 'FM999,999,999,990')),
        'currency', 'UGX', 'transaction_date', v_now)), v_key, false);
  ELSE
    INSERT INTO public.supporter_roi_payments (rent_request_id, supporter_id, rent_amount, roi_amount, payment_number, due_date, paid_at, status)
    VALUES (rr.id, rr.supporter_id, rr.rent_amount, v_amount, p_payment_number, v_now, v_now, 'paid')
    RETURNING id INTO v_payment_id;
    v_group := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_out', 'amount', v_amount, 'category', 'roi_expense',
        'ledger_scope', 'platform', 'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        'description', format('Platform Returns payout #%s to supporter for rent facilitation of UGX %s', p_payment_number, v_rent_txt),
        'currency', 'UGX', 'transaction_date', v_now),
      jsonb_build_object('user_id', rr.supporter_id, 'direction', 'cash_in', 'amount', v_amount, 'category', 'roi_wallet_credit',
        'ledger_scope', 'wallet', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'supporter_roi_payments', 'source_id', rr.id, 'linked_party', 'platform',
        -- The rate in the text is the one paid; from the caller's text only the proxy-agent note is kept.
        'description', format('%s%% monthly reward (payment #%s) on rent facilitation of UGX %s', trim_scale(v_rate), p_payment_number, v_rent_txt)
                       || COALESCE(' ' || substring(p_wallet_description from '(\(managed by [^()]*(?:\([^()]*\)[^()]*)*\))\s*$'), ''),
        'currency', 'UGX', 'transaction_date', v_now)), v_key, false);
  END IF;

  UPDATE public.rent_requests
     SET next_roi_due_date = v_now + interval '30 days',
         total_roi_paid = rr.total_roi_paid + v_amount,
         roi_payments_count = p_payment_number
   WHERE id = rr.id;

  RETURN jsonb_build_object('status', 'posted', 'mode', CASE WHEN p_reinvest_portfolio_id IS NULL THEN 'wallet' ELSE 'reinvest' END,
    'payment_id', v_payment_id, 'payment_number', p_payment_number, 'amount', v_amount, 'rate', trim_scale(v_rate), 'transaction_group_id', v_group,
    'portfolio_id', p_reinvest_portfolio_id, 'previous_principal', CASE WHEN p_reinvest_portfolio_id IS NULL THEN NULL ELSE v_new_principal - v_amount END,
    'new_principal', v_new_principal);
END
$function$
;


-- ===========================================================================
-- F. Monitoring and readiness
-- ===========================================================================
-- The structural checks gain the Phase 2 ones (the drift recorder runs them every 10 minutes).
CREATE OR REPLACE FUNCTION public.assert_partner_return_policy_intact()
 RETURNS TABLE(check_name text, ok boolean, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pol   public.partner_return_policy%ROWTYPE;
  v_src   text;
  v_bad   integer;
BEGIN
  SELECT * INTO v_pol FROM public.partner_return_policy WHERE id;
  RETURN QUERY SELECT 'policy_row_exists', v_pol.id IS NOT NULL, 'partner_return_policy must hold exactly one row';

  RETURN QUERY SELECT 'gate_trigger_enabled',
    EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
             AND t.tgname = 'trg_partner_return_rate_policy' AND t.tgenabled <> 'D')
    AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
             AND t.tgname = 'trg_partner_return_carry_guard' AND t.tgenabled <> 'D'),
    'every new portfolio must pass the Partner Returns gate';

  RETURN QUERY SELECT 'rate_has_no_default',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios'
               AND c.column_name = 'roi_percentage' AND c.column_default IS NULL AND c.is_nullable = 'NO'),
    'the portfolio Returns rate must be required and have no default (the gate fills it)';

  RETURN QUERY SELECT 'decision_stamp_columns',
    (SELECT count(*) = 4 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios'
        AND c.column_name IN ('entitled_rate', 'rate_basis', 'rate_decided_at', 'rate_existing_at_decision')),
    'each portfolio must record the rate it was entitled to and why';

  RETURN QUERY SELECT 'note_rate_column',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'promissory_notes'
               AND c.column_name = 'return_rate' AND c.is_nullable = 'NO'),
    'each promissory note must record its Returns rate';

  RETURN QUERY SELECT 'note_triggers_enabled',
    (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid = 'public.promissory_notes'::regclass
       AND t.tgname IN ('trg_zz_stamp_note_return_rate', 'trg_zz_guard_note_return_rate') AND t.tgenabled <> 'D'),
    'promissory notes must be stamped at insert and guarded on update';

  RETURN QUERY SELECT 'cutoff_guards_enabled',
    (SELECT count(*) = 4 FROM pg_trigger t
      WHERE t.tgname IN ('trg_partner_return_policy_guard', 'trg_partner_return_cohort_guard',
                         'trg_partner_return_note_windows_guard', 'trg_partner_return_legacy_guard') AND t.tgenabled <> 'D'),
    'the cut-off, the existing-partner list, the note windows and the legacy list must be protected';

  RETURN QUERY SELECT 'cutoff_set_when_enabled',
    (NOT COALESCE(v_pol.enabled, false))
      OR (v_pol.cutoff_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.partner_return_cohort)),
    'with the switch on, the cut-off must be set and the existing-partner list filled';

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'set_partner_return_policy' LIMIT 1;
  RETURN QUERY SELECT 'switch_ceo_only',
    v_src IS NOT NULL AND position('ARRAY[''ceo'']' in v_src) > 0
      AND v_src !~ 'ARRAY\[[^]]*''cfo''',
    'only the CEO may turn the switch on or off';

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'apply_portfolio_renewal' LIMIT 1;
  RETURN QUERY SELECT 'renewal_keeps_rate',
    v_src IS NOT NULL
      AND v_src !~* 'update\s+(public\.)?investor_portfolios(\s+(as\s+)?\w+)?\s+set\s+([^;]*?,\s*)?(\w+\.)?roi_percentage\s*=',
    'a renewal must keep the portfolio''s stored rate';

  SELECT count(*) INTO v_bad FROM public.partner_rate_conformance(NULL);
  RETURN QUERY SELECT 'rates_conform', v_bad = 0,
    v_bad || ' portfolio(s) since the cut-off have a Returns rate that does not match what they were entitled to (see partner_rate_conformance())';

  RETURN QUERY SELECT 'cron_jobs_scheduled',
    CASE WHEN to_regclass('cron.job') IS NULL THEN false
         ELSE (SELECT count(*) = 2 FROM cron.job j
                WHERE j.jobname IN ('apply-portfolio-rate-changes-705pm', 'partner-rate-drift-check') AND j.active) END,
    'the next-cycle job and the drift check must be scheduled';
  -- Phase 2: every creation path leaves the rate to the gate (or types it on purpose, which the
  -- gate checks), and nothing quotes a fixed 15% any more.
  SELECT count(*) INTO v_bad
    FROM (VALUES ('funder_create_pending_portfolio'), ('psm_confirm_commitment_for'),
                 ('partner_support_houses'), ('countersign_prepare_support')) f(fn)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn)
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = f.fn
                    AND p.prosrc ~* 'insert\s+into\s+(public\.)?investor_portfolios\s*\([^)]*roi_percentage');
  RETURN QUERY SELECT 'creation_paths_leave_rate_to_gate', v_bad = 0,
    v_bad || ' creation function(s) are missing or type a Returns rate themselves (they must let the gate decide)';

  SELECT count(*) INTO v_bad
    FROM (VALUES ('psm_confirm_commitment_for', 'partner_rate_now'), ('partner_support_houses', 'partner_rate_now'),
                 ('get_countersign_summary', 'partner_rate_now'), ('hr_pay_post_staff_reinvestment', 'partner_rate_context'),
                 ('agent_list_empty_house_opportunities', 'partner_quote_rate'),
                 ('empty_house_opportunity_summary', 'partner_quote_rate'),
                 ('post_rent_facilitation_reward', 'rent_facilitation_reward_rates')) f(fn, must)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn)
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = f.fn AND position(f.must in p.prosrc) = 0);
  RETURN QUERY SELECT 'creation_paths_use_rule', v_bad = 0,
    v_bad || ' function(s) no longer take their rate from the Partner Returns rule';

  SELECT count(*) INTO v_bad
    FROM (VALUES ('enqueue_funder_house_notice'), ('get_or_create_house_share_link'), ('get_supporter_pool_stats'),
                 ('agent_create_promissory_note_for_houses'), ('agent_create_promissory_note'),
                 ('psm_queue_promissory_pledge_notice'), ('post_rent_facilitation_reward'),
                 ('agent_list_empty_house_opportunities'), ('empty_house_opportunity_summary'),
                 ('get_or_create_plan_share_link'), ('public_house_support_offer'), ('public_support_plan'),
                 ('hr_pay_post_staff_reinvestment'), ('partner_supported_house_returns')) f(fn)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = f.fn)
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = f.fn
                    AND p.prosrc ~ '0\.15|\m(15|20)%');
  RETURN QUERY SELECT 'quotes_use_stored_or_public_rate', v_bad = 0,
    v_bad || ' quote/notice function(s) are missing or still use a fixed Returns rate';

  RETURN QUERY SELECT 'phase2_triggers_enabled',
    (SELECT count(*) = 3 FROM pg_trigger t
      WHERE t.tgname IN ('trg_zz_partner_note_linked_late', 'trg_zz_stamp_rent_reward_rate_ins',
                         'trg_zz_stamp_rent_reward_rate_upd') AND t.tgenabled <> 'D'),
    'late-linked promissory notes and legacy rent-facilitation fundings must be decided by the rule';

  RETURN QUERY SELECT 'release_ready', COALESCE(v_pol.release_ready OR NOT v_pol.enabled, true),
    'the switch may only be on after the release marked every creation path, agreement, edge function and screen ready (ready='
      || COALESCE(v_pol.release_ready::text, 'unknown') || ')';
END $function$;
REVOKE ALL ON FUNCTION public.assert_partner_return_policy_intact() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_partner_return_policy_intact() TO service_role;
