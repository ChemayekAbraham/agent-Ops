CREATE OR REPLACE FUNCTION public.funder_support_tenant_direct(p_rent_request_ids uuid[], p_promised_deposit_date date DEFAULT NULL::date, p_term_months integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_total numeric := 0;
  v_capacity numeric;
  v_mode text;
  v_res jsonb;
  v_key text;
  v_commitment uuid;
  v_portfolio uuid;
  v_receivables integer := 0;
  v_released boolean := false;
  v_port_status text;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for direct tenant support' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;

  -- A plan with no assigned agent is not fundable. Checked before any claim
  -- or commitment is confirmed by this function.
  IF EXISTS (
    SELECT 1
      FROM public.rent_requests rr
     WHERE rr.id = ANY (p_rent_request_ids)
       AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NULL
  ) THEN
    RAISE EXCEPTION 'NO_AGENT_ASSIGNED: This Rent Plan has no assigned agent, so it cannot be funded.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_key := 'psmd-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids, ','));

  -- Second tap: the first call already created the commitment and may already
  -- have spent the float. Replay that result instead of asking for a deposit.
  IF EXISTS (
    SELECT 1 FROM public.partner_self_commitments c
     WHERE c.partner_id = v_uid AND c.idempotency_key = v_key
  ) THEN
    v_res := public.psm_confirm_commitment_for(
      v_uid, p_rent_request_ids, p_term_months, v_key, v_uid, NULL, 'float'
    );
    v_commitment := (v_res->>'commitment_id')::uuid;
    SELECT fp.portfolio_id, ip.status
      INTO v_portfolio, v_port_status
      FROM public.funder_pending_portfolios fp
      JOIN public.investor_portfolios ip ON ip.id = fp.portfolio_id
     WHERE fp.commitment_id = v_commitment
     ORDER BY fp.created_at DESC
     LIMIT 1;

    IF public._pipeline_switch_on('funder_direct_release')
       AND v_portfolio IS NOT NULL
       AND v_port_status IN ('pending_ops_approval', 'awaiting_partner_details')
       AND NOT EXISTS (
         SELECT 1 FROM public.landlord_float_receivables r
          WHERE r.commitment_id = v_commitment AND r.status = 'outstanding'
       ) THEN
      PERFORM set_config('app.funder_direct_release', 'on', true);
      PERFORM public._approve_pending_portfolio_core(v_portfolio, v_uid);
      v_released := true;
    ELSIF v_port_status = 'active' THEN
      v_released := true;
    END IF;

    RETURN v_res || jsonb_build_object(
      'funding_mode', CASE WHEN v_released THEN 'float' ELSE 'replay' END,
      'portfolio_id', v_portfolio,
      'status', CASE WHEN v_released THEN 'active' ELSE COALESCE(v_port_status, v_res->>'status') END,
      'awaiting_ops_approval', NOT v_released,
      'landlord_float_released', v_released,
      'idempotent_replay', true
    );
  END IF;

  SELECT COALESCE(SUM(public.self_support_gross(p.funding_amount)), 0) INTO v_total
    FROM public.v_partner_self_fundable_plans p
   WHERE p.rent_request_id = ANY (p_rent_request_ids);

  v_capacity := public.funder_support_capacity(v_uid);

  IF v_total > 0 AND v_capacity >= v_total THEN
    v_mode := 'float';
  ELSE
    v_mode := 'receivable';
    IF p_promised_deposit_date IS NULL THEN
      RAISE EXCEPTION 'DEPOSIT_DATE_REQUIRED'
        USING HINT = 'Choose the date you will deposit this amount into your wallet.',
              ERRCODE = 'check_violation';
    END IF;
    IF p_promised_deposit_date < CURRENT_DATE THEN
      RAISE EXCEPTION 'DEPOSIT_DATE_IN_PAST' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM public.psm_release_cancelled_idempotency(v_uid, v_key);

  v_res := public.psm_confirm_commitment_for(
    v_uid, p_rent_request_ids, p_term_months,
    v_key,
    v_uid, NULL, v_mode
  );

  v_commitment := (v_res->>'commitment_id')::uuid;
  v_portfolio := NULLIF(v_res->>'portfolio_id', '')::uuid;

  IF COALESCE((v_res->>'idempotent_replay')::boolean, false) THEN
    RETURN v_res || jsonb_build_object('funding_mode', v_mode, 'portfolio_id', v_portfolio);
  END IF;

  IF v_mode = 'receivable' THEN
    -- Unchanged: nothing is released here. The deposit-credit trigger calls
    -- the core once the float actually covers this portfolio and the switch is ON.
    INSERT INTO public.landlord_float_receivables (
      funder_id, commitment_id, rent_request_id, landlord_id, landlord_name,
      tenant_id, agent_id, amount, promised_deposit_date, notes
    )
    SELECT v_uid, v_commitment, l.rent_request_id, rr.landlord_id, ld.name,
           rr.tenant_id, COALESCE(rr.assigned_agent_id, rr.agent_id), l.principal,
           p_promised_deposit_date,
           'Funder supported the tenant directly with no wallet balance; deposit promised'
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
     WHERE l.commitment_id = v_commitment
    ON CONFLICT DO NOTHING;

    v_receivables := (SELECT COUNT(*) FROM public.landlord_float_receivables
                       WHERE commitment_id = v_commitment AND status = 'outstanding');

    -- Switch ON: this promise is not a Partner Ops or CFO approval. The float
    -- credit trigger releases it through the core when the deposit lands.
    IF public._pipeline_switch_on('funder_direct_release') AND v_portfolio IS NOT NULL THEN
      UPDATE public.investor_portfolios
         SET status = 'awaiting_funder_deposit'
       WHERE id = v_portfolio
         AND status IN ('pending_ops_approval', 'awaiting_partner_details');
    END IF;

    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
              'Funder pledged direct landlord float with a promised deposit date',
              jsonb_build_object('amount', v_total, 'promised_deposit_date', p_promised_deposit_date,
                                 'receivable_lines', v_receivables, 'funding_mode', 'receivable'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN v_res || jsonb_build_object(
      'funding_mode', 'receivable',
      'receivable_lines', v_receivables,
      'promised_deposit_date', p_promised_deposit_date,
      'landlord_float_released', false,
      'awaiting_ops_approval', NOT public._pipeline_switch_on('funder_direct_release')
    );
  END IF;

  IF public._pipeline_switch_on('funder_direct_release') AND v_portfolio IS NOT NULL THEN
    PERFORM set_config('app.funder_direct_release', 'on', true);
    PERFORM public._approve_pending_portfolio_core(v_portfolio, v_uid);

    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
              'Funder direct release: rent moved to the agent landlord float',
              jsonb_build_object('amount', v_total, 'funding_mode', 'float',
                                 'portfolio_id', v_portfolio, 'status', 'active',
                                 'direct_release', true));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    PERFORM public.psm_audit(v_uid, v_uid, 'direct_support_released_to_agent',
      'partner_self_commitments', v_commitment,
      jsonb_build_object('amount', v_total, 'funding_mode', 'float', 'portfolio_id', v_portfolio));

    RETURN v_res || jsonb_build_object(
      'funding_mode', 'float',
      'status', 'active',
      'awaiting_ops_approval', false,
      'from_withdrawable', 0,
      'from_float', v_total,
      'landlord_float_released', true,
      'available_balance', public.funder_float_available(v_uid)
    );
  END IF;

  -- Switch OFF: the historical Partner Ops queue. No money moves here.
  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
            'Funder submitted direct tenant support for Partner Ops vetting',
            jsonb_build_object('amount', v_total, 'funding_mode', v_mode,
                               'portfolio_id', v_portfolio, 'status', 'pending_ops_approval'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  PERFORM public.psm_audit(v_uid, v_uid, 'direct_support_submitted_for_vetting',
    'partner_self_commitments', v_commitment,
    jsonb_build_object('amount', v_total, 'funding_mode', v_mode, 'portfolio_id', v_portfolio));

  RETURN v_res || jsonb_build_object(
    'funding_mode', v_mode,
    'status', 'pending_ops_approval',
    'awaiting_ops_approval', true,
    'from_withdrawable', 0,
    'from_float', 0,
    'landlord_float_released', false,
    'available_balance', public.funder_float_available(v_uid)
  );
END;
$function$
