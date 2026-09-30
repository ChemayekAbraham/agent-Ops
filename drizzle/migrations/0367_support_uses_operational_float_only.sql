-- Support capacity comes from operational float only (withdrawable money is never used to fund support).
CREATE OR REPLACE FUNCTION public.funder_support_capacity(p_user_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.funder_float_available(p_user_id);
$function$;

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
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for direct tenant support' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids,1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;

  SELECT COALESCE(SUM(p.funding_amount),0) INTO v_total
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = ANY(p_rent_request_ids);

  -- Operational float only; withdrawable money is never used for support.
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

  v_key := 'psmd-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids,','));

  PERFORM public.psm_release_cancelled_idempotency(v_uid, v_key);

  v_res := public.psm_confirm_commitment_for(
    v_uid, p_rent_request_ids, p_term_months,
    v_key,
    v_uid, NULL, v_mode
  );

  v_commitment := (v_res->>'commitment_id')::uuid;
  v_portfolio := NULLIF(v_res->>'portfolio_id','')::uuid;

  IF COALESCE((v_res->>'idempotent_replay')::boolean, false) THEN
    RETURN v_res || jsonb_build_object('funding_mode', v_mode);
  END IF;

  IF v_mode = 'receivable' THEN
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
      'landlord_float_released', false
    );
  END IF;

  -- Covered path: NOTHING is debited here. approve_pending_portfolio performs
  -- the operational-float debit, the ledger posting and the landlord float release.
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
$function$;