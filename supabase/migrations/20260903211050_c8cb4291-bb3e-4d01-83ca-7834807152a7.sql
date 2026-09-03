CREATE OR REPLACE FUNCTION public.settle_tenant_rent_from_deposit(p_deposit_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_dep            record;
  v_plan           record;
  v_float          numeric := 0;
  v_applied        numeric := 0;
  v_surplus        numeric := 0;
  v_parent_id      uuid;
  v_whitelisted    boolean := false;
  v_comm_total     numeric := 0;
  v_comm_agent     numeric := 0;
  v_comm_parent    numeric := 0;
  v_legs           jsonb;
  v_group          uuid := gen_random_uuid();
  v_tracking       text;
  v_collection_id  uuid;
  v_repayment_id   uuid;
  v_new_status     text;
  v_is_agent_actor boolean := false;
  v_agent          record;
  v_reason         text;
  v_purpose        text;
  v_locked         record;
  v_out            numeric := 0;
  v_daily          numeric := 0;
  v_paid_today     numeric := 0;
  v_due            numeric := 0;
BEGIN
  SELECT dr.id, dr.user_id, dr.amount, dr.status, dr.deposit_purpose::text AS purpose,
         dr.transaction_id, dr.provider, p.phone, p.full_name
    INTO v_dep
    FROM public.deposit_requests dr
    JOIN public.profiles p ON p.id = dr.user_id
   WHERE dr.id = p_deposit_request_id;

  IF NOT FOUND THEN
    INSERT INTO public.tenant_self_repayment_attempts (deposit_request_id, deposit_amount, outcome, reason)
    VALUES (p_deposit_request_id, 0, 'refused', 'no_profile_or_deposit')
    ON CONFLICT (deposit_request_id) DO UPDATE
      SET outcome = 'refused', reason = 'no_profile_or_deposit', updated_at = now();
    RETURN jsonb_build_object('success', false, 'reason', 'no_profile_or_deposit');
  END IF;

  IF v_dep.status <> 'approved' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'deposit_not_approved');
  END IF;

  IF EXISTS (SELECT 1 FROM public.repayments r WHERE r.deposit_request_id = p_deposit_request_id) THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'reason', 'already_settled');
  END IF;

  v_purpose := lower(COALESCE(v_dep.purpose, ''));

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = v_dep.user_id
       AND ur.role IN ('agent', 'senior_agent', 'sub_agent')
       AND COALESCE(ur.enabled, true)
  ) INTO v_is_agent_actor;

  IF v_is_agent_actor AND v_purpose <> 'personal_rent_repayment' THEN
    v_reason := 'agent_float_deposit_not_rent_purpose';
  END IF;

  SELECT * INTO v_plan FROM public.tenant_self_repayment_plan(v_dep.user_id);

  IF v_reason IS NULL AND v_plan.rent_request_id IS NULL THEN
    v_reason := 'no_active_rent_plan';
  END IF;

  IF v_reason IS NULL THEN
    -- Race fence: serialise every payment against this same plan (tenant deposits
    -- as well as the agent collection engine, which locks the same row on UPDATE).
    PERFORM pg_advisory_xact_lock(hashtextextended(v_plan.rent_request_id::text, 0));

    SELECT COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) AS outstanding,
           COALESCE(rr.daily_repayment, 0) AS daily
      INTO v_locked
      FROM public.rent_requests rr
     WHERE rr.id = v_plan.rent_request_id
     FOR UPDATE;

    v_out   := GREATEST(0, COALESCE(v_locked.outstanding, 0));
    v_daily := GREATEST(0, COALESCE(v_locked.daily, 0));

    -- Today's daily instalment is shared with the agent collection engine.
    SELECT COALESCE(SUM(ac.amount), 0)
      INTO v_paid_today
      FROM public.agent_collections ac
     WHERE ac.rent_request_id = v_plan.rent_request_id
       AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
           = (now() AT TIME ZONE 'Africa/Kampala')::date;

    v_due := CASE WHEN v_daily <= 0 THEN v_out
                  ELSE LEAST(v_out, GREATEST(0, v_daily - v_paid_today)) END;

    v_float   := GREATEST(0, COALESCE((public.get_user_wallet_view(v_dep.user_id) ->> 'float_balance')::numeric, 0));
    v_applied := round(LEAST(COALESCE(v_dep.amount, 0), v_due, v_float), 2);

    IF v_out <= 0 THEN
      v_reason := 'plan_already_cleared';
    ELSIF v_due <= 0 THEN
      v_reason := 'daily_amount_already_paid';
    ELSIF v_applied <= 0 THEN
      v_reason := CASE WHEN v_float <= 0 THEN 'no_operational_float' ELSE 'nothing_to_apply' END;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.tenant_self_repayment_attempts (
      deposit_request_id, tenant_id, rent_request_id, agent_id,
      deposit_amount, applied_amount, outcome, reason, paid_from_phone, metadata
    ) VALUES (
      p_deposit_request_id, v_dep.user_id, v_plan.rent_request_id, v_plan.agent_id,
      COALESCE(v_dep.amount, 0), NULL, 'refused', v_reason, v_dep.phone,
      jsonb_build_object(
        'deposit_purpose', v_purpose,
        'float_balance', v_float,
        'outstanding', v_out,
        'daily_repayment', v_daily,
        'paid_today', v_paid_today,
        'due_now', v_due
      )
    )
    ON CONFLICT (deposit_request_id) DO UPDATE
      SET outcome = 'refused', reason = v_reason, updated_at = now();
    RETURN jsonb_build_object('success', false, 'reason', v_reason);
  END IF;

  v_surplus := GREATEST(0, round(COALESCE(v_dep.amount, 0) - v_applied, 2));

  -- Commission: 10% total. Sub-agent 8% + verified parent 2%, unless whitelisted.
  IF v_plan.agent_id IS NOT NULL THEN
    v_comm_total := round(v_applied * 0.10, 2);

    SELECT sa.parent_agent_id INTO v_parent_id
      FROM public.agent_subagents sa
     WHERE sa.sub_agent_id = v_plan.agent_id
       AND sa.status IN ('verified', 'approved', 'accepted')
       AND sa.parent_agent_id <> sa.sub_agent_id
     LIMIT 1;

    v_whitelisted := public.is_subagent_commission_whitelisted(v_plan.agent_id);

    IF v_parent_id IS NOT NULL AND NOT v_whitelisted THEN
      v_comm_agent  := round(v_applied * 0.08, 2);
      v_comm_parent := v_comm_total - v_comm_agent;
    ELSE
      v_comm_agent  := v_comm_total;
      v_comm_parent := 0;
    END IF;
  END IF;

  v_tracking := 'TSP-' || substr(v_group::text, 1, 8);

  v_legs := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_dep.user_id,
      'amount', v_applied,
      'direction', 'cash_out',
      'category', 'tenant_repayment',
      'ledger_scope', 'wallet',
      'classification', 'production',
      'description', 'Tenant self-repayment settled from operational float',
      'recipient_type', 'operational_wallet',
      'wallet_bucket', 'float',
      'linked_party', v_plan.landlord_id,
      'source_table', 'agent_collections',
      'source_id', v_plan.rent_request_id,
      'metadata', jsonb_build_object('deposit_request_id', p_deposit_request_id, 'channel', 'tenant_deposit_auto')
    ),
    jsonb_build_object(
      'user_id', v_dep.user_id,
      'amount', v_applied,
      'direction', 'cash_in',
      'category', 'rent_receivable_created',
      'ledger_scope', 'bridge',
      'classification', 'production',
      'description', format('Tenant self-repayment for landlord %s', COALESCE(v_plan.landlord_name, 'Unknown')),
      'linked_party', v_plan.landlord_id,
      'source_table', 'agent_collections',
      'source_id', v_plan.rent_request_id,
      'metadata', jsonb_build_object('deposit_request_id', p_deposit_request_id, 'channel', 'tenant_deposit_auto')
    )
  );

  IF v_comm_total > 0 THEN
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_plan.agent_id,
        'amount', v_comm_agent,
        'direction', 'cash_in',
        'category', 'agent_commission_earned',
        'ledger_scope', 'wallet',
        'classification', 'production',
        'description', CASE WHEN v_comm_parent > 0
                            THEN '8% commission on tenant self-repayment'
                            ELSE '10% commission on tenant self-repayment' END,
        'recipient_type', 'user',
        'source_table', 'agent_collections',
        'source_id', v_plan.rent_request_id,
        'metadata', jsonb_build_object('deposit_request_id', p_deposit_request_id, 'channel', 'tenant_deposit_auto')
      ),
      jsonb_build_object(
        'user_id', v_plan.agent_id,
        'amount', v_comm_total,
        'direction', 'cash_out',
        'category', 'agent_commission_payable',
        'ledger_scope', 'platform',
        'classification', 'production',
        'description', 'Platform commission payout on tenant self-repayment',
        'source_table', 'agent_collections',
        'source_id', v_plan.rent_request_id,
        'metadata', jsonb_build_object('deposit_request_id', p_deposit_request_id, 'channel', 'tenant_deposit_auto')
      )
    );

    IF v_comm_parent > 0 THEN
      v_legs := v_legs || jsonb_build_array(
        jsonb_build_object(
          'user_id', v_parent_id,
          'amount', v_comm_parent,
          'direction', 'cash_in',
          'category', 'agent_commission_earned',
          'ledger_scope', 'wallet',
          'classification', 'production',
          'description', '2% parent override on tenant self-repayment',
          'recipient_type', 'user',
          'source_table', 'agent_collections',
          'source_id', v_plan.rent_request_id,
          'metadata', jsonb_build_object('deposit_request_id', p_deposit_request_id, 'channel', 'tenant_deposit_auto')
        )
      );
    END IF;
  END IF;

  PERFORM public.create_ledger_transaction(
    v_legs,
    format('tenant_self_repayment:%s', p_deposit_request_id)
  );

  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes,
    collection_channel, initiated_by, deposit_request_id, performance_weight,
    expected_amount, shortfall_amount, is_partial
  ) VALUES (
    v_plan.agent_id, v_dep.user_id, v_plan.rent_request_id, v_applied, 'in_app_wallet'::collection_payment_method,
    v_float, v_float, v_tracking, 'Tenant self-repayment from own deposit',
    'tenant_deposit_auto', v_dep.user_id, p_deposit_request_id, 2,
    NULLIF(v_due, 0),
    GREATEST(0, v_due - v_applied),
    v_due > v_applied
  )
  RETURNING id INTO v_collection_id;

  UPDATE public.rent_requests
     SET amount_repaid = COALESCE(amount_repaid, 0) + v_applied,
         status = CASE
                    WHEN COALESCE(amount_repaid, 0) + v_applied >= COALESCE(total_repayment, 0) THEN 'completed'
                    WHEN status IN ('disbursed', 'funded', 'approved') THEN 'repaying'
                    ELSE status
                  END,
         last_payment_amount = v_applied,
         updated_at = now()
   WHERE id = v_plan.rent_request_id
  RETURNING status INTO v_new_status;

  INSERT INTO public.repayments (
    tenant_id, rent_request_id, amount,
    payment_method, paid_by, initiated_by, deposit_request_id, external_reference
  ) VALUES (
    v_dep.user_id, v_plan.rent_request_id, v_applied,
    'in_app_wallet', v_dep.user_id, v_dep.user_id, p_deposit_request_id,
    COALESCE(v_dep.transaction_id, v_tracking)
  )
  RETURNING id INTO v_repayment_id;

  INSERT INTO public.tenant_self_repayment_attempts (
    deposit_request_id, tenant_id, rent_request_id, agent_id,
    deposit_amount, applied_amount, surplus_amount, outcome, reason,
    paid_from_phone, transaction_group_id, metadata
  ) VALUES (
    p_deposit_request_id, v_dep.user_id, v_plan.rent_request_id, v_plan.agent_id,
    COALESCE(v_dep.amount, 0), v_applied, v_surplus, 'settled', NULL,
    v_dep.phone, v_group,
    jsonb_build_object(
      'collection_id', v_collection_id,
      'repayment_id', v_repayment_id,
      'tracking_id', v_tracking,
      'commission_total', v_comm_total,
      'commission_agent', v_comm_agent,
      'commission_parent', v_comm_parent,
      'parent_agent_id', v_parent_id,
      'other_active_plans', v_plan.other_active_plans,
      'performance_weight', 2,
      'new_status', v_new_status,
      'paid_today_before', v_paid_today,
      'due_now', v_due,
      'outstanding_after', GREATEST(0, v_out - v_applied)
    )
  )
  ON CONFLICT (deposit_request_id) DO UPDATE
    SET outcome = 'settled', reason = NULL, applied_amount = EXCLUDED.applied_amount,
        surplus_amount = EXCLUDED.surplus_amount, metadata = EXCLUDED.metadata,
        transaction_group_id = EXCLUDED.transaction_group_id, updated_at = now();

  INSERT INTO public.tenant_self_repayment_notices (
    deposit_request_id, recipient_role, recipient_user_id, phone, sms_text
  ) VALUES (
    p_deposit_request_id, 'tenant', v_dep.user_id, v_dep.phone,
    format(
      'Welile: Rent payment received. UGX %s applied to your Rent Plan%s. Remaining balance: UGX %s. Plan status: %s.',
      to_char(v_applied, 'FM999,999,999'),
      CASE WHEN v_surplus > 0 THEN format(', UGX %s kept for your next payment', to_char(v_surplus, 'FM999,999,999')) ELSE '' END,
      to_char(GREATEST(0, v_out - v_applied), 'FM999,999,999'),
      COALESCE(v_new_status, 'repaying')
    )
  )
  ON CONFLICT (deposit_request_id, recipient_role) DO NOTHING;

  IF v_plan.agent_id IS NOT NULL THEN
    SELECT p.phone, p.full_name INTO v_agent FROM public.profiles p WHERE p.id = v_plan.agent_id;
    INSERT INTO public.tenant_self_repayment_notices (
      deposit_request_id, recipient_role, recipient_user_id, phone, sms_text
    ) VALUES (
      p_deposit_request_id, 'agent', v_plan.agent_id, v_agent.phone,
      format(
        'Welile: %s paid their own rent. UGX %s recorded, your commission UGX %s. Remaining balance: UGX %s.',
        COALESCE(v_dep.full_name, 'Your tenant'),
        to_char(v_applied, 'FM999,999,999'),
        to_char(v_comm_agent, 'FM999,999,999'),
        to_char(GREATEST(0, v_out - v_applied), 'FM999,999,999')
      )
    )
    ON CONFLICT (deposit_request_id, recipient_role) DO NOTHING;
  END IF;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, description, metadata)
  VALUES (
    'payment_made', v_dep.user_id, 'rent_requests', v_plan.rent_request_id,
    'Tenant self-repayment settled from operational float',
    jsonb_build_object(
      'deposit_request_id', p_deposit_request_id,
      'channel', 'tenant_deposit_auto',
      'applied_amount', v_applied,
      'surplus_amount', v_surplus,
      'commission_total', v_comm_total,
      'agent_id', v_plan.agent_id,
      'performance_weight', 2
    )
  );

  BEGIN
    PERFORM public.capture_trust_signal(v_dep.user_id, 'rent_payment', NULL, NULL, NULL, NULL, NULL,
      'Tenant self-repayment');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'rent_request_id', v_plan.rent_request_id,
    'applied_amount', v_applied,
    'surplus_amount', v_surplus,
    'due_now', v_due,
    'paid_today_before', v_paid_today,
    'outstanding_after', GREATEST(0, v_out - v_applied),
    'commission_total', v_comm_total,
    'commission_agent', v_comm_agent,
    'commission_parent', v_comm_parent,
    'collection_id', v_collection_id,
    'repayment_id', v_repayment_id,
    'tracking_id', v_tracking,
    'new_status', v_new_status,
    'performance_weight', 2
  );
END;
$function$;