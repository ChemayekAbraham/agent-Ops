-- 1) Expose per-commitment kind (houses vs rent plans) + portfolio code in one pass (no N+1).
CREATE OR REPLACE FUNCTION public.partner_self_portfolio(p_partner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid := COALESCE(p_partner_id, auth.uid());
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF v_target <> v_uid AND NOT (
      public.is_ops_role(v_uid) OR public.has_role(v_uid,'partner_ops') OR public.has_role(v_uid,'financial_ops') OR public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'coo')
      OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'manager') OR public.has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501';
  END IF;

  RETURN (
    WITH house_agg AS (
      SELECT commitment_id, COUNT(*) AS house_count,
             MIN(portfolio_id) AS portfolio_id,
             MIN(metadata->>'portfolio_code') AS portfolio_code
      FROM public.partner_supported_houses
      WHERE partner_id = v_target AND status <> 'cancelled'
      GROUP BY commitment_id
    ),
    line_agg AS (
      SELECT commitment_id, COUNT(*) AS line_count
      FROM public.partner_self_funding_lines
      WHERE partner_id = v_target AND status <> 'cancelled'
      GROUP BY commitment_id
    ),
    commitments AS (
      SELECT c.*,
             CASE WHEN COALESCE(h.house_count,0) > 0 THEN 'houses'
                  WHEN COALESCE(l.line_count,0) > 0 THEN 'rent'
                  ELSE 'unknown' END AS kind,
             h.portfolio_id AS house_portfolio_id,
             h.portfolio_code AS portfolio_code,
             COALESCE(h.house_count,0) AS house_count,
             COALESCE(l.line_count,0) AS rent_line_count
      FROM public.partner_self_commitments c
      LEFT JOIN house_agg h ON h.commitment_id = c.id
      LEFT JOIN line_agg  l ON l.commitment_id = c.id
      WHERE c.partner_id = v_target
    ),
    lines AS (
      SELECT l.*, rr.rent_amount, rr.duration_days, rr.daily_repayment,
             rr.request_city, rr.house_category, rr.status AS plan_status,
             rr.disbursed_at, rr.amount_repaid,
             split_part(COALESCE(NULLIF(btrim(tp.full_name),''),'Tenant'),' ',1) AS tenant_first_name,
             tp.full_name AS tenant_full_name,
             tp.avatar_url AS tenant_avatar_url,
             COALESCE(NULLIF(btrim(lp.full_name),''),'Landlord') AS landlord_name
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
      WHERE l.partner_id = v_target AND l.status <> 'cancelled'
    ),
    holds AS (
      SELECT * FROM public.partner_self_plan_claims
      WHERE partner_id = v_target AND status='held' AND expires_at > now()
    ),
    payouts AS (
      SELECT * FROM public.partner_self_payout_cycles WHERE partner_id = v_target
    )
    SELECT jsonb_build_object(
      'available_balance', public.get_user_available_balance(v_target),
      'minimum_funding', 50000,
      'totals', jsonb_build_object(
        'committed', (SELECT COALESCE(SUM(committed_amount),0) FROM commitments WHERE status <> 'cancelled'),
        'active', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='active'),
        'earning', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='active'),
        'idle', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='idle'),
        'completed', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='completed'),
        'total_earned', (SELECT COALESCE(SUM(total_earned),0) FROM commitments),
        'total_paid', (SELECT COALESCE(SUM(total_paid),0) FROM commitments),
        'lines_count', (SELECT COUNT(*) FROM lines)
      ),
      'commitments', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb) FROM commitments c),
      'lines', (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC), '[]'::jsonb) FROM lines l),
      'active_holds', (SELECT COALESCE(jsonb_agg(to_jsonb(h)), '[]'::jsonb) FROM holds h),
      'payout_cycles', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.cycle_end DESC), '[]'::jsonb) FROM payouts p),
      'next_payout', (SELECT jsonb_build_object('date', MIN(next_payout_at))
                        FROM commitments WHERE status='active' AND next_payout_at IS NOT NULL)
    )
  );
END;
$function$;

-- 2) House support can now top up an EXISTING house portfolio (never a rent-plan one).
CREATE OR REPLACE FUNCTION public.partner_support_houses(
  p_house_ids uuid[],
  p_term_months integer DEFAULT 1,
  p_idempotency_key text DEFAULT NULL::text,
  p_commitment_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := GREATEST(1, LEAST(COALESCE(p_term_months,1), 12));
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
    AND NOT EXISTS (
      SELECT 1 FROM public.partner_supported_houses s
       WHERE s.house_id = h.id AND s.status IN ('pending','active')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.promissory_note_house_intents i
       WHERE i.house_id = h.id AND i.status = 'reserved'
    );

  SELECT COUNT(*), COALESCE(SUM(principal),0) INTO v_count, v_total FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.get_user_available_balance(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % available.',
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
      'available_balance', public.get_user_available_balance(v_partner)
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
    'available_balance', public.get_user_available_balance(v_partner)
  );
END;
$function$;