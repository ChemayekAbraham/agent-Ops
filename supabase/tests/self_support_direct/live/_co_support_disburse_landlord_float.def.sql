CREATE OR REPLACE FUNCTION public._co_support_disburse_landlord_float(p_commitment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_co uuid;
  v_inv public.co_support_invites%ROWTYPE;
  v_lines integer;
  v_paid integer;
  v_rent numeric;
  v_lead_line uuid;
  v_rr record;
  v_line record;
  v_alloc uuid;
  v_ref text;
  v_landlord_name text;
  v_pool_entry uuid;
  v_pool_drawn numeric := 0;
  v_treasury jsonb;
  v_notices integer := 0;
BEGIN
  SELECT l.co_support_id INTO v_co
    FROM public.partner_self_funding_lines l
   WHERE l.commitment_id = p_commitment_id AND l.co_support_id IS NOT NULL
   LIMIT 1;
  IF v_co IS NULL THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'not_co_support');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('co-support-float-' || v_co::text));
  SELECT * INTO v_inv FROM public.co_support_invites WHERE id = v_co;

  SELECT count(*),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.general_ledger g
            WHERE g.idempotency_key = 'psm-commit-' || l.commitment_id::text
              AND g.ledger_scope = 'wallet'
              AND g.direction = 'cash_out')),
         COALESCE(SUM(COALESCE(l.rent_amount, l.principal)), 0)
    INTO v_lines, v_paid, v_rent
    FROM public.partner_self_funding_lines l
   WHERE l.co_support_id = v_co AND l.status <> 'cancelled';

  -- Wait for the other half. The second half's approval releases the float.
  IF v_lines <> 2 OR v_paid < 2 THEN
    PERFORM public.psm_audit(auth.uid(), v_inv.lead_partner_id, 'co_support_float_waiting',
      'co_support_invites', v_co,
      jsonb_build_object('lines', v_lines, 'paid', v_paid, 'commitment_id', p_commitment_id));
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'co_support_waiting_for_other_half',
                              'lines', v_lines, 'paid', v_paid);
  END IF;

  SELECT l.id INTO v_lead_line
    FROM public.partner_self_funding_lines l
   WHERE l.co_support_id = v_co AND l.partner_id = v_inv.lead_partner_id AND l.status <> 'cancelled'
   LIMIT 1;

  IF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = 'psm-float-' || v_lead_line::text) THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'already_released');
  END IF;

  SELECT rr.id, rr.tenant_id, rr.landlord_id,
         COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
         ld.name AS landlord_name,
         COALESCE(ld.mobile_money_number, ld.phone) AS landlord_phone
    INTO v_rr
    FROM public.rent_requests rr
    LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
   WHERE rr.id = v_inv.rent_request_id;

  -- Both partners have paid, so never leave the money without a landlord float:
  -- refuse, and the caller's transaction (both debits) rolls back.
  IF v_rr.agent_id IS NULL THEN
    RAISE EXCEPTION 'NO_AGENT_ASSIGNED: This Rent Plan has no assigned agent, so it cannot be funded.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id = v_rr.id AND a.status IN ('open', 'partially_paid')
  ) THEN
    RAISE EXCEPTION 'PLAN_ALREADY_FUNDED: This Rent Plan already has landlord float.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_landlord_name := COALESCE(v_rr.landlord_name, 'Unknown Landlord');
  v_ref := 'PSC-' || upper(substr(replace(v_co::text, '-', ''), 1, 8));

  -- One allocation for the full rent: the agent pays the landlord once.
  INSERT INTO public.agent_landlord_float_allocations (
    agent_id, tenant_id, rent_request_id, landlord_id,
    landlord_name, landlord_phone, allocated_amount, source,
    funded_by_partner_id, funding_reference
  ) VALUES (
    v_rr.agent_id, v_rr.tenant_id, v_rr.id, v_rr.landlord_id,
    v_landlord_name, v_rr.landlord_phone, v_rent, 'partner_self_funding',
    v_inv.lead_partner_id, v_ref
  )
  RETURNING id INTO v_alloc;

  -- One ledger pair per half, each under its own line (same key shape as a
  -- single-partner release: psm-float-<line>).
  FOR v_line IN
    SELECT l.id, l.partner_id, COALESCE(l.rent_amount, l.principal) AS amount
      FROM public.partner_self_funding_lines l
     WHERE l.co_support_id = v_co AND l.status <> 'cancelled'
     ORDER BY (l.partner_id = v_inv.lead_partner_id) DESC, l.created_at
  LOOP
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'direction','cash_out','amount', v_line.amount,
          'category','rent_disbursement','ledger_scope','platform',
          'source_table','partner_self_funding_lines','source_id', v_line.id,
          'reference_id', v_ref,
          'user_id', v_rr.agent_id,
          'linked_party', v_line.partner_id::text,
          'description','Partner self-managed funding released to agent landlord float for ' || v_landlord_name || ' (co-support half)'
        ),
        jsonb_build_object(
          'direction','cash_in','amount', v_line.amount,
          'category','rent_receivable_created','ledger_scope','bridge',
          'source_table','partner_self_funding_lines','source_id', v_line.id,
          'reference_id', v_ref,
          'user_id', v_rr.agent_id,
          'linked_party', v_line.partner_id::text,
          'description','Landlord float credited (partner-funded, co-support half) - ' || v_landlord_name
        )
      ),
      idempotency_key := 'psm-float-' || v_line.id::text
    );

    v_pool_entry := NULL;
    SELECT e.id INTO v_pool_entry FROM public.landlord_pool_entries e
     WHERE e.source_table = 'partner_self_funding_lines' AND e.source_id = v_line.id
       AND e.status = 'open' AND e.in_pool > 0;
    IF v_pool_entry IS NOT NULL THEN
      v_pool_drawn := v_pool_drawn + coalesce((public.landlord_pool_deploy(
        v_rr.id, v_line.amount, 'self_support', v_alloc, v_pool_entry,
        'co_support_disburse_landlord_float') ->> 'drawn')::numeric, 0);
    END IF;
  END LOOP;

  INSERT INTO public.agent_float_funding (agent_id, amount, funded_by, rent_request_id, notes)
  VALUES (v_rr.agent_id, v_rent, auth.uid(), v_rr.id,
          'Partner-funded landlord float (co-support) for ' || v_landlord_name)
  ON CONFLICT DO NOTHING;

  UPDATE public.rent_requests
     SET status = 'funded',
         funded_at = COALESCE(funded_at, now()),
         self_funding_partner_id = COALESCE(self_funding_partner_id, v_inv.lead_partner_id),
         self_funding_line_id = COALESCE(self_funding_line_id, v_lead_line),
         updated_at = now()
   WHERE id = v_rr.id
     AND status IN ('approved','coo_approved','pending','agent_ops_approved',
                    'tenant_ops_approved','landlord_ops_approved','agent_verified','cfo_approved');

  v_treasury := public.recognise_funding_treasury(v_rr.id);

  -- Agent and landlord notices: one each, for the full rent, under the lead.
  INSERT INTO public.partner_float_agent_notices (
    commitment_id, topup_id, partner_id, agent_id, landlord_id,
    landlord_name, amount, tenant_count, rent_request_ids
  ) VALUES (
    v_inv.lead_commitment_id, NULL, v_inv.lead_partner_id, v_rr.agent_id, v_rr.landlord_id,
    COALESCE(v_rr.landlord_name, 'the landlord'), v_rent, 1, ARRAY[v_rr.id]
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_notices = ROW_COUNT;

  BEGIN
    INSERT INTO public.partner_float_landlord_notices (
      commitment_id, topup_id, partner_id, agent_id, agent_name, landlord_id,
      landlord_name, landlord_phone, amount, tenant_count, tenant_first_names, rent_request_ids
    )
    SELECT v_inv.lead_commitment_id, NULL, v_inv.lead_partner_id, v_rr.agent_id, pa.full_name, v_rr.landlord_id,
           COALESCE(v_rr.landlord_name, 'the landlord'), ld.phone, v_rent, 1,
           CASE WHEN btrim(COALESCE(pt.full_name, '')) <> ''
                THEN ARRAY[initcap(split_part(btrim(pt.full_name), ' ', 1))]
                ELSE '{}'::text[] END,
           ARRAY[v_rr.id]
      FROM (SELECT 1) one
      LEFT JOIN public.profiles pa ON pa.id = v_rr.agent_id
      LEFT JOIN public.profiles pt ON pt.id = v_rr.tenant_id
      LEFT JOIN public.landlords ld ON ld.id = v_rr.landlord_id
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.psm_audit(auth.uid(), v_inv.lead_partner_id, 'landlord_sms_queue_failed',
      'co_support_invites', v_co, jsonb_build_object('error', SQLERRM));
  END;

  IF COALESCE(current_setting('app.funder_direct_release', true), '') = 'on' THEN
    BEGIN
      PERFORM public._funder_direct_release_note(v_rr.id, v_rr.agent_id, v_alloc);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'funder direct release flag failed for co-supported plan %: %', v_rr.id, SQLERRM;
    END;
  END IF;

  PERFORM public.psm_audit(auth.uid(), v_inv.lead_partner_id, 'landlord_float_disbursed',
    'co_support_invites', v_co,
    jsonb_build_object('funded_lines', 2, 'total_amount', v_rent, 'allocation_id', v_alloc,
                       'notices_queued', v_notices, 'treasury', v_treasury,
                       'landlord_pool_drawn', v_pool_drawn, 'co_support', true));

  RETURN jsonb_build_object('funded', 1, 'skipped', 0, 'total_amount', v_rent,
                            'notices_queued', v_notices,
                            'treasury_recognised', CASE WHEN (v_treasury->>'status') = 'recognised' THEN 1 ELSE 0 END,
                            'landlord_pool_drawn', v_pool_drawn,
                            'co_support_id', v_co, 'allocation_id', v_alloc);
END;
$function$
