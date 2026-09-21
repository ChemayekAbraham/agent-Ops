-- Tenant self-repayment: apply the whole deposit (paid-ahead allowed), clearer SMS
CREATE OR REPLACE FUNCTION public.settle_tenant_rent_from_deposit(p_deposit_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dep            record;
  v_plan           record;
  v_rr             uuid;
  v_avail          numeric := 0;
  v_applied        numeric := 0;
  v_surplus        numeric := 0;
  v_parent_id      uuid;
  v_whitelisted    boolean := false;
  v_comm_total     numeric := 0;
  v_comm_agent     numeric := 0;
  v_comm_parent    numeric := 0;
  v_legs           jsonb;
  v_group_a        uuid;
  v_group_c        uuid;
  v_group_b        uuid;
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
  v_in_scope       boolean := false;
  v_orch           jsonb;
  v_wf             jsonb;
  v_reg_count      integer := 0;
  v_reg_match      integer := 0;
  v_identity       text := 'unverified_no_registered_number';
  v_cached         numeric := 0;
  v_cached_f       numeric := 0;
  v_avail_w        numeric := 0;
  v_avail_f        numeric := 0;
  v_from_w         numeric := 0;
  v_from_f         numeric := 0;
  v_today          date;
  v_covered_days   integer := 0;
  v_paid_up_to     date;
  v_today_paid     numeric := 0;
  v_today_gap      numeric := 0;
  v_first_name     text;
  v_tenant_sms     text;
  v_agent_sms      text;
  v_out_after      numeric := 0;
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
  v_today   := (now() AT TIME ZONE 'Africa/Kampala')::date;

  IF COALESCE(NULLIF(trim(v_dep.phone), ''), '') = '' THEN
    v_reason := 'no_registered_phone';
  ELSE
    SELECT count(*),
           count(*) FILTER (
             WHERE public.normalize_phone_last9(udn.phone_last9)
                 = public.normalize_phone_last9(v_dep.phone))
      INTO v_reg_count, v_reg_match
      FROM public.user_deposit_numbers udn
     WHERE udn.user_id = v_dep.user_id;

    IF v_reg_count = 0 THEN
      v_identity := 'unverified_no_registered_number';
    ELSIF v_reg_match > 0 THEN
      v_identity := 'verified_registered_number';
    ELSE
      v_identity := 'mismatch';
      v_reason   := 'payer_number_mismatch';
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.rent_requests rr
       WHERE rr.agent_id = v_dep.user_id
         AND rr.status IN ('repaying', 'disbursed', 'funded')
    ) OR EXISTS (
      SELECT 1 FROM public.agent_collections ac
       WHERE ac.agent_id = v_dep.user_id
    ) OR EXISTS (
      SELECT 1 FROM public.agent_float_limits fl
       WHERE fl.agent_id = v_dep.user_id
    ) INTO v_is_agent_actor;

    IF v_is_agent_actor AND v_purpose <> 'personal_rent_repayment' THEN
      v_reason := 'agent_float_deposit_not_rent_purpose';
    END IF;
  END IF;

  SELECT * INTO v_plan FROM public.tenant_self_repayment_plan(v_dep.user_id);
  v_rr := v_plan.rent_request_id;

  IF v_reason IS NULL AND v_rr IS NULL THEN
    v_reason := 'no_active_rent_plan';
  END IF;

  IF v_reason IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_rr::text, 0));

    SELECT COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) AS outstanding,
           COALESCE(rr.daily_repayment, 0) AS daily
      INTO v_locked
      FROM public.rent_requests rr
     WHERE rr.id = v_rr
     FOR UPDATE;

    v_out   := GREATEST(0, COALESCE(v_locked.outstanding, 0));
    v_daily := GREATEST(0, COALESCE(v_locked.daily, 0));

    SELECT COALESCE(SUM(ac.amount), 0)
      INTO v_paid_today
      FROM public.agent_collections ac
     WHERE ac.rent_request_id = v_rr
       AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = v_today;

    -- informational only from 2026-09-21: the applied amount is no longer capped
    -- at today's remaining daily amount. Paying ahead is supported by the
    -- day-by-day settlement rebuild, so the whole deposit is applied.
    v_due := CASE WHEN v_daily <= 0 THEN v_out
                  ELSE LEAST(v_out, GREATEST(0, v_daily - v_paid_today)) END;

    SELECT COALESCE(withdrawable_balance, 0), COALESCE(float_balance, 0)
      INTO v_cached, v_cached_f
      FROM public.wallets WHERE user_id = v_dep.user_id;
    v_avail_w := GREATEST(0, LEAST(
      COALESCE((public.get_user_wallet_view(v_dep.user_id) ->> 'withdrawable')::numeric, 0),
      COALESCE(v_cached, 0)));

    IF NOT v_is_agent_actor THEN
      v_avail_f := GREATEST(0, COALESCE(v_cached_f, 0));
    END IF;

    v_avail   := v_avail_w + v_avail_f;
    v_applied := round(LEAST(COALESCE(v_dep.amount, 0), v_out, v_avail), 2);
    v_from_w  := LEAST(v_applied, v_avail_w);
    v_from_f  := round(v_applied - v_from_w, 2);

    IF v_out <= 0 THEN
      v_reason := 'plan_already_cleared';
    ELSIF v_applied <= 0 THEN
      v_reason := CASE WHEN v_avail <= 0 THEN 'no_available_balance' ELSE 'nothing_to_apply' END;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.tenant_self_repayment_attempts (
      deposit_request_id, tenant_id, rent_request_id, agent_id,
      deposit_amount, applied_amount, outcome, reason, paid_from_phone, metadata
    ) VALUES (
      p_deposit_request_id, v_dep.user_id, v_rr, v_plan.agent_id,
      COALESCE(v_dep.amount, 0), NULL, 'refused', v_reason, v_dep.phone,
      jsonb_build_object(
        'deposit_purpose', v_purpose,
        'withdrawable', v_avail,
        'outstanding', v_out,
        'daily_repayment', v_daily,
        'paid_today', v_paid_today,
        'due_now', v_due,
        'identity_check', v_identity,
        'registered_numbers', v_reg_count
      )
    )
    ON CONFLICT (deposit_request_id) DO UPDATE
      SET outcome = 'refused', reason = v_reason, updated_at = now(),
          metadata = EXCLUDED.metadata;
    RETURN jsonb_build_object('success', false, 'reason', v_reason,
                              'identity_check', v_identity);
  END IF;

  v_surplus  := GREATEST(0, round(COALESCE(v_dep.amount, 0) - v_applied, 2));
  v_in_scope := public.is_treasury_waterfall_scope(v_rr);
  v_tracking := 'TSP-' || substr(gen_random_uuid()::text, 1, 8);

  IF v_plan.agent_id IS NOT NULL THEN
    SELECT sa.parent_agent_id INTO v_parent_id
      FROM public.agent_subagents sa
     WHERE sa.sub_agent_id = v_plan.agent_id
       AND sa.status IN ('verified', 'approved', 'accepted')
       AND sa.parent_agent_id <> sa.sub_agent_id
     LIMIT 1;
    v_whitelisted := public.is_subagent_commission_whitelisted(v_plan.agent_id);
  END IF;

  v_legs := jsonb_build_array(
    jsonb_build_object(
      'amount', v_applied,
      'direction', 'cash_in',
      'category', 'tenant_repayment',
      'ledger_scope', 'platform',
      'classification', 'production',
      'description', format('Tenant self-payment reduces rent receivable (%s)',
                            COALESCE(v_plan.landlord_name, 'Unknown')),
      'linked_party', v_plan.landlord_id,
      'source_table', 'agent_collections',
      'source_id', v_rr,
      'reference_id', v_tracking
    )
  );

  IF v_from_w > 0 THEN
    v_legs := v_legs || jsonb_build_array(jsonb_build_object(
      'user_id', v_dep.user_id,
      'amount', v_from_w,
      'direction', 'cash_out',
      'category', 'tenant_rent_settlement',
      'ledger_scope', 'wallet',
      'wallet_bucket', 'withdrawable',
      'recipient_type', 'user',
      'classification', 'production',
      'description', 'Tenant self-payment settled from own withdrawable balance',
      'linked_party', v_plan.landlord_id,
      'source_table', 'agent_collections',
      'source_id', v_rr,
      'reference_id', v_tracking));
  END IF;

  IF v_from_f > 0 THEN
    v_legs := v_legs || jsonb_build_array(jsonb_build_object(
      'user_id', v_dep.user_id,
      'amount', v_from_f,
      'direction', 'cash_out',
      'category', 'agent_float_used_for_rent',
      'ledger_scope', 'wallet',
      'wallet_bucket', 'float',
      'recipient_type', 'operational_wallet',
      'classification', 'production',
      'description', 'Tenant self-payment settled from own deposited balance',
      'linked_party', v_plan.landlord_id,
      'source_table', 'agent_collections',
      'source_id', v_rr,
      'reference_id', v_tracking));
  END IF;

  IF NOT v_in_scope AND v_plan.agent_id IS NOT NULL THEN
    v_comm_total := round(v_applied * 0.10, 2);
    IF v_parent_id IS NOT NULL AND NOT v_whitelisted THEN
      v_comm_agent  := round(v_comm_total * 0.80, 2);
      v_comm_parent := v_comm_total - v_comm_agent;
    ELSE
      v_comm_agent  := v_comm_total;
      v_comm_parent := 0;
    END IF;

    IF v_comm_total > 0 THEN
      v_legs := v_legs || jsonb_build_array(
        jsonb_build_object(
          'user_id', v_plan.agent_id, 'amount', v_comm_agent, 'direction', 'cash_in',
          'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
          'classification', 'production',
          'description', 'Agent commission on tenant self-payment (legacy plan)',
          'source_table', 'agent_collections', 'source_id', v_rr, 'reference_id', v_tracking),
        jsonb_build_object(
          'amount', v_comm_total, 'direction', 'cash_out',
          'category', 'agent_commission_payable', 'ledger_scope', 'platform',
          'classification', 'production',
          'description', 'Platform commission expense on tenant self-payment (legacy plan)',
          'source_table', 'agent_collections', 'source_id', v_rr, 'reference_id', v_tracking));
      IF v_comm_parent > 0 THEN
        v_legs := v_legs || jsonb_build_array(jsonb_build_object(
          'user_id', v_parent_id, 'amount', v_comm_parent, 'direction', 'cash_in',
          'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
          'classification', 'production',
          'description', 'Parent override 2% on tenant self-payment (legacy plan)',
          'source_table', 'agent_collections', 'source_id', v_rr, 'reference_id', v_tracking));
      END IF;
    END IF;
  END IF;

  v_group_a := public.create_ledger_transaction(
    v_legs, format('tenant_self_repayment:%s', p_deposit_request_id));

  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes,
    collection_channel, initiated_by, deposit_request_id, performance_weight,
    expected_amount, shortfall_amount, is_partial
  ) VALUES (
    v_plan.agent_id, v_dep.user_id, v_rr, v_applied, 'in_app_wallet'::collection_payment_method,
    v_avail, GREATEST(0, v_avail - v_applied), v_tracking,
    'Tenant self-payment from own balance',
    'tenant_deposit_auto', v_dep.user_id, p_deposit_request_id, 2,
    NULLIF(v_due, 0), GREATEST(0, v_due - v_applied), v_due > v_applied
  )
  RETURNING id INTO v_collection_id;

  v_orch := public.record_rent_request_repayment_v2(
    p_tenant_id            => v_dep.user_id,
    p_amount               => v_applied,
    p_source_table         => 'agent_collections',
    p_source_id            => v_collection_id,
    p_transaction_group_id => v_group_a,
    p_rent_request_id      => v_rr
  );
  v_repayment_id := NULLIF(v_orch->>'repayment_id','')::uuid;
  v_wf           := v_orch->'waterfall';
  v_group_b      := NULLIF(v_wf->>'transaction_group_id','')::uuid;

  IF v_repayment_id IS NOT NULL THEN
    UPDATE public.repayments
       SET payment_method     = 'in_app_wallet',
           paid_by            = v_dep.user_id,
           initiated_by       = v_dep.user_id,
           deposit_request_id = p_deposit_request_id,
           external_reference = COALESCE(v_dep.transaction_id, v_tracking)
     WHERE id = v_repayment_id;
  END IF;

  UPDATE public.rent_requests
     SET last_payment_amount = v_applied,
         status = CASE WHEN status IN ('disbursed','funded','approved') AND status <> 'completed'
                       THEN 'repaying' ELSE status END,
         updated_at = now()
   WHERE id = v_rr
  RETURNING status INTO v_new_status;

  IF v_in_scope AND COALESCE(v_wf->>'status','') = 'posted' AND v_plan.agent_id IS NOT NULL THEN
    v_comm_total := GREATEST(0, COALESCE((v_wf->>'agent_commission')::numeric, 0));
    IF v_parent_id IS NOT NULL AND NOT v_whitelisted THEN
      v_comm_agent  := round(v_comm_total * 0.80, 2);
      v_comm_parent := v_comm_total - v_comm_agent;
    ELSE
      v_comm_agent  := v_comm_total;
      v_comm_parent := 0;
    END IF;

    IF v_comm_total > 0 THEN
      v_legs := jsonb_build_array(
        jsonb_build_object(
          'amount', v_comm_total, 'direction', 'cash_out',
          'category', 'agent_commission_settled', 'ledger_scope', 'platform',
          'classification', 'production',
          'description', 'Agent Commission Payable settled on tenant self-payment',
          'source_table', 'agent_collections', 'source_id', v_collection_id,
          'reference_id', v_tracking),
        jsonb_build_object(
          'user_id', v_plan.agent_id, 'amount', v_comm_agent, 'direction', 'cash_in',
          'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
          'classification', 'production',
          'description', CASE WHEN v_comm_parent > 0
                              THEN 'Collector agent 8% on tenant self-payment'
                              ELSE 'Agent 10% on tenant self-payment' END,
          'source_table', 'agent_collections', 'source_id', v_collection_id,
          'reference_id', v_tracking));
      IF v_comm_parent > 0 THEN
        v_legs := v_legs || jsonb_build_array(jsonb_build_object(
          'user_id', v_parent_id, 'amount', v_comm_parent, 'direction', 'cash_in',
          'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
          'classification', 'production',
          'description', 'Verified parent override 2% on tenant self-payment',
          'source_table', 'agent_collections', 'source_id', v_collection_id,
          'reference_id', v_tracking));
      END IF;

      v_group_c := public.create_ledger_transaction(
        v_legs, format('tenant_self_commission:%s', p_deposit_request_id));
    END IF;
  END IF;

  v_out_after := GREATEST(0, v_out - v_applied);

  -- Cover picture read from the day-by-day settlement record this payment rebuilt.
  IF v_daily > 0 THEN
    SELECT count(*), max(d.day)
      INTO v_covered_days, v_paid_up_to
      FROM (
        SELECT s.day, SUM(s.amount) AS paid
          FROM public.rent_day_settlements s
         WHERE s.rent_request_id = v_rr
         GROUP BY s.day
      ) d
     WHERE d.paid >= v_daily
       AND d.day >= v_today;

    SELECT COALESCE(SUM(s.amount), 0)
      INTO v_today_paid
      FROM public.rent_day_settlements s
     WHERE s.rent_request_id = v_rr
       AND s.day = v_today;

    v_today_gap := GREATEST(0, round(v_daily - v_today_paid, 2));
  END IF;

  v_covered_days := COALESCE(v_covered_days, 0);
  v_first_name   := COALESCE(NULLIF(split_part(COALESCE(v_dep.full_name, ''), ' ', 1), ''), 'there');

  IF v_out_after <= 0 THEN
    v_tenant_sms := format(
      E'Welile: Rent payment received, %s.\nPaid: UGX %s - your Rent Plan is now fully paid. Congratulations.%s\nRef %s. Thank you.',
      v_first_name,
      to_char(v_applied, 'FM999,999,999'),
      CASE WHEN v_surplus > 0
           THEN format(E'\nUGX %s stays in your Welile wallet.', to_char(v_surplus, 'FM999,999,999'))
           ELSE '' END,
      v_tracking);
  ELSIF v_daily > 0 AND v_today_gap > 0 THEN
    v_tenant_sms := format(
      E'Welile: Rent payment received, %s.\nPaid: UGX %s\nStill due today: UGX %s for %s.\nRent balance: UGX %s\nRef %s. Thank you.',
      v_first_name,
      to_char(v_applied, 'FM999,999,999'),
      to_char(v_today_gap, 'FM999,999,999'),
      to_char(v_today, 'DD Mon YYYY'),
      to_char(v_out_after, 'FM999,999,999'),
      v_tracking);
  ELSE
    v_tenant_sms := format(
      E'Welile: Rent payment received, %s.\nPaid: UGX %s%s\nCovers %s day%s - you are paid up to %s.\nRent balance: UGX %s\nRef %s. Thank you.',
      v_first_name,
      to_char(v_applied, 'FM999,999,999'),
      CASE WHEN v_surplus > 0 THEN ' from your wallet balance.' ELSE '' END,
      GREATEST(1, v_covered_days),
      CASE WHEN GREATEST(1, v_covered_days) = 1 THEN '' ELSE 's' END,
      to_char(COALESCE(v_paid_up_to, v_today), 'DD Mon YYYY'),
      to_char(v_out_after, 'FM999,999,999'),
      v_tracking);
  END IF;

  INSERT INTO public.tenant_self_repayment_notices (
    deposit_request_id, recipient_role, recipient_user_id, phone, sms_text
  ) VALUES (
    p_deposit_request_id, 'tenant', v_dep.user_id, v_dep.phone, v_tenant_sms
  )
  ON CONFLICT (deposit_request_id, recipient_role) DO NOTHING;

  IF v_plan.agent_id IS NOT NULL THEN
    SELECT p.phone, p.full_name INTO v_agent FROM public.profiles p WHERE p.id = v_plan.agent_id;

    IF v_daily > 0 AND v_today_gap > 0 AND v_out_after > 0 THEN
      v_agent_sms := format(
        E'Welile: %s part-paid his own rent.\nReceived: UGX %s of UGX %s for today.\nStill to collect today: UGX %s.\nYour commission: UGX %s - already in your withdrawable balance.\nHis rent balance: UGX %s.',
        COALESCE(v_dep.full_name, 'Your tenant'),
        to_char(v_applied, 'FM999,999,999'),
        to_char(v_daily, 'FM999,999,999'),
        to_char(v_today_gap, 'FM999,999,999'),
        to_char(v_comm_agent, 'FM999,999,999'),
        to_char(v_out_after, 'FM999,999,999'));
    ELSE
      v_agent_sms := format(
        E'Welile: %s paid his own rent.\nReceived: UGX %s (covers %s day%s, paid up to %s)\nYour commission: UGX %s - already in your withdrawable balance.\nHis rent balance: UGX %s.%s',
        COALESCE(v_dep.full_name, 'Your tenant'),
        to_char(v_applied, 'FM999,999,999'),
        GREATEST(1, v_covered_days),
        CASE WHEN GREATEST(1, v_covered_days) = 1 THEN '' ELSE 's' END,
        to_char(COALESCE(v_paid_up_to, v_today), 'DD Mon YYYY'),
        to_char(v_comm_agent, 'FM999,999,999'),
        to_char(v_out_after, 'FM999,999,999'),
        CASE WHEN v_out_after <= 0 THEN ' Rent Plan fully paid.'
             WHEN v_paid_up_to IS NOT NULL AND v_paid_up_to > v_today
             THEN format(' No collection needed from him until %s.', to_char(v_paid_up_to + 1, 'DD Mon'))
             ELSE '' END);
    END IF;

    INSERT INTO public.tenant_self_repayment_notices (
      deposit_request_id, recipient_role, recipient_user_id, phone, sms_text
    ) VALUES (
      p_deposit_request_id, 'agent', v_plan.agent_id, v_agent.phone, v_agent_sms
    )
    ON CONFLICT (deposit_request_id, recipient_role) DO NOTHING;
  END IF;

  INSERT INTO public.tenant_self_repayment_attempts (
    deposit_request_id, tenant_id, rent_request_id, agent_id,
    deposit_amount, applied_amount, surplus_amount, outcome, reason,
    paid_from_phone, transaction_group_id, metadata
  ) VALUES (
    p_deposit_request_id, v_dep.user_id, v_rr, v_plan.agent_id,
    COALESCE(v_dep.amount, 0), v_applied, v_surplus, 'settled', NULL,
    v_dep.phone, v_group_a,
    jsonb_build_object(
      'collection_id', v_collection_id,
      'repayment_id', v_repayment_id,
      'tracking_id', v_tracking,
      'identity_check', v_identity,
      'registered_numbers', v_reg_count,
      'in_treasury_scope', v_in_scope,
      'settlement_group_id', v_group_a,
      'waterfall_group_id', v_group_b,
      'commission_group_id', v_group_c,
      'waterfall', v_wf,
      'commission_total', v_comm_total,
      'commission_agent', v_comm_agent,
      'commission_parent', v_comm_parent,
      'parent_agent_id', v_parent_id,
      'other_active_plans', v_plan.other_active_plans,
      'performance_weight', 2,
      'money_source', CASE WHEN v_from_f > 0 AND v_from_w > 0 THEN 'tenant_withdrawable+deposited_float'
                           WHEN v_from_f > 0 THEN 'tenant_deposited_float'
                           ELSE 'tenant_withdrawable' END,
      'applied_from_withdrawable', v_from_w,
      'applied_from_float', v_from_f,
      'withdrawable_before', v_avail,
      'withdrawable_after', GREATEST(0, v_avail - v_applied),
      'new_status', v_new_status,
      'paid_today_before', v_paid_today,
      'due_now', v_due,
      'days_covered', v_covered_days,
      'paid_up_to', v_paid_up_to,
      'today_gap', v_today_gap,
      'outstanding_after', v_out_after
    )
  )
  ON CONFLICT (deposit_request_id) DO UPDATE
    SET outcome = 'settled', reason = NULL, applied_amount = EXCLUDED.applied_amount,
        surplus_amount = EXCLUDED.surplus_amount, metadata = EXCLUDED.metadata,
        transaction_group_id = EXCLUDED.transaction_group_id, updated_at = now();

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, description, metadata)
  VALUES (
    'payment_made', v_dep.user_id, 'rent_requests', v_rr,
    'Tenant self-payment settled from own balance',
    jsonb_build_object(
      'deposit_request_id', p_deposit_request_id,
      'channel', 'tenant_deposit_auto',
      'applied_amount', v_applied,
      'surplus_amount', v_surplus,
      'commission_total', v_comm_total,
      'agent_id', v_plan.agent_id,
      'in_treasury_scope', v_in_scope,
      'settlement_group_id', v_group_a,
      'waterfall_group_id', v_group_b,
      'commission_group_id', v_group_c,
      'days_covered', v_covered_days,
      'performance_weight', 2
    )
  );

  BEGIN
    PERFORM public.capture_trust_signal(v_dep.user_id, 'rent_payment', NULL, NULL, NULL, NULL, NULL,
      'Tenant self-payment');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'rent_request_id', v_rr,
    'applied_amount', v_applied,
    'surplus_amount', v_surplus,
    'due_now', v_due,
    'paid_today_before', v_paid_today,
    'days_covered', v_covered_days,
    'paid_up_to', v_paid_up_to,
    'today_gap', v_today_gap,
    'outstanding_after', v_out_after,
    'in_treasury_scope', v_in_scope,
    'settlement_group_id', v_group_a,
    'waterfall_group_id', v_group_b,
    'commission_group_id', v_group_c,
    'waterfall', v_wf,
    'commission_total', v_comm_total,
    'commission_agent', v_comm_agent,
    'commission_parent', v_comm_parent,
    'identity_check', v_identity,
    'collection_id', v_collection_id,
    'repayment_id', v_repayment_id,
    'tracking_id', v_tracking,
    'new_status', v_new_status,
    'money_source', CASE WHEN v_from_f > 0 AND v_from_w > 0 THEN 'tenant_withdrawable+deposited_float'
                         WHEN v_from_f > 0 THEN 'tenant_deposited_float'
                         ELSE 'tenant_withdrawable' END,
    'performance_weight', 2
  );
END;
$function$;