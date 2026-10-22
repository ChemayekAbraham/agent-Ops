-- One-off data correction: MATOVU SADICK's Rent Plan (471ff399-eee0-46cf-b4fd-c18f7e039bbe).
--
-- What went wrong: on 1 Sep 2026 (09:12 UTC) a Tenant Ops correction wrote the full total into amount_repaid before any payment existed. The nightly
-- auto_close_fully_repaid_rents job then closed the plan as "completed - fully repaid". From 10 Sep every merchant-code payment was refused with
-- "no_active_rent_plan" and parked as an operational float deposit in his own wallet (15 payments, UGX 266,000, all still in his float).
--
-- What this does, once and only for this plan:
--   1. Reopens the plan to 'repaying' with amount_repaid = 0 and the payment status back to 'paying'. It goes straight to 'repaying' (never 'funded'), so the
--      funding triggers that log fee revenue and grant credit-limit bonuses do not run a second time.
--   2. Settles each of the 15 approved deposits in the order they arrived, the same way settle_tenant_rent_from_deposit does for a tenant paying from their
--      own balance: tenant_repayment / agent_float_used_for_rent / agent commission ledger legs (same idempotency key, so the live function can never
--      post a deposit twice), one agent_collections row, one repayments row, the attempts row set to 'settled'.
--   3. Dates every one of those rows (ledger transaction_date, collection, repayment, event) at the moment the money really arrived, so the payment history
--      shows 10 Sep ... 21 Oct and not today. The ledger's own created_at still records the true posting time.
--   4. Rebuilds the day-by-day settlement for this plan.
-- It does NOT send any SMS or notice (these are old payments), does NOT touch the landlord record (the landlord was paid in full on 1 Sep and his balance is 0),
-- does NOT touch any other plan, and moves no cash outside the tenant's own wallet float. Safe to run twice: it does nothing unless the plan is still in the
-- broken state, and skips any deposit that is already settled.

DO $fix$
DECLARE
  c_rr       CONSTANT uuid := '471ff399-eee0-46cf-b4fd-c18f7e039bbe';
  c_tenant   CONSTANT uuid := '85317091-81bd-4ff2-8ea1-dc3ae51117f1';
  v_rr       record;
  v_dep      record;
  v_float    numeric;
  v_out      numeric;
  v_daily    numeric;
  v_applied  numeric;
  v_when     timestamptz;
  v_day      date;
  v_paid_day numeric;
  v_due      numeric;
  v_parent   uuid;
  v_white    boolean;
  v_ctotal   numeric;
  v_cagent   numeric;
  v_cparent  numeric;
  v_legs     jsonb;
  v_group    uuid;
  v_track    text;
  v_col      uuid;
  v_rep      uuid;
  v_phone    text;
  v_settled  integer := 0;
BEGIN
  SELECT rr.* INTO v_rr FROM public.rent_requests rr WHERE rr.id = c_rr AND rr.tenant_id = c_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'matovu fix: plan not found, nothing to do';
    RETURN;
  END IF;

  -- Reopen only a plan that is still in the exact broken state.
  IF v_rr.status = 'completed'
     AND v_rr.agent_payment_status_reason = 'auto_completed_fully_repaid'
     AND NOT EXISTS (SELECT 1 FROM public.repayments x WHERE x.rent_request_id = c_rr)
     AND NOT EXISTS (SELECT 1 FROM public.agent_collections x WHERE x.rent_request_id = c_rr) THEN
    UPDATE public.rent_requests
       SET status = 'repaying',
           amount_repaid = 0,
           agent_payment_status = 'paying',
           agent_payment_status_reason = 'reopened_after_wrong_auto_complete',
           agent_payment_status_set_at = now(),
           agent_payment_status_set_by = NULL,
           updated_at = now()
     WHERE id = c_rr;
    BEGIN
      INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
      VALUES ('rent_plan_reopened_after_wrong_auto_complete', 'rent_requests', c_rr::text,
              'amount_repaid was set to the full total by a correction before any payment existed',
              jsonb_build_object('previous_status', 'completed', 'previous_amount_repaid', v_rr.amount_repaid,
                                 'previous_reason', v_rr.agent_payment_status_reason));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  ELSIF v_rr.status NOT IN ('repaying', 'funded', 'disbursed') THEN
    RAISE NOTICE 'matovu fix: plan is % and not in the broken state, nothing to do', v_rr.status;
    RETURN;
  END IF;

  SELECT COALESCE(float_balance, 0) INTO v_float FROM public.wallets WHERE user_id = c_tenant;
  v_float := COALESCE(v_float, 0);

  SELECT sa.parent_agent_id INTO v_parent
    FROM public.agent_subagents sa
   WHERE sa.sub_agent_id = v_rr.agent_id
     AND sa.status IN ('verified', 'approved', 'accepted')
     AND sa.parent_agent_id <> sa.sub_agent_id
   LIMIT 1;
  v_white := public.is_subagent_commission_whitelisted(v_rr.agent_id);

  FOR v_dep IN
    SELECT dr.id, dr.amount, dr.transaction_id,
           COALESCE(
             (SELECT min(gl.transaction_date) FROM public.general_ledger gl
               WHERE gl.source_table = 'deposit_requests' AND gl.source_id = dr.id
                 AND gl.user_id = c_tenant AND gl.direction = 'cash_in'),
             dr.created_at) AS landed_at
      FROM public.deposit_requests dr
     WHERE dr.user_id = c_tenant
       AND dr.status = 'approved'
       AND dr.deposit_purpose::text = 'operational_float'
       AND NOT EXISTS (SELECT 1 FROM public.repayments r WHERE r.deposit_request_id = dr.id)
     ORDER BY 3, dr.created_at, dr.id
  LOOP
    SELECT GREATEST(0, COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0)), GREATEST(0, COALESCE(daily_repayment, 0))
      INTO v_out, v_daily
      FROM public.rent_requests WHERE id = c_rr;

    v_applied := round(LEAST(v_dep.amount, v_out, v_float), 2);
    IF v_applied <= 0 THEN
      RAISE NOTICE 'matovu fix: deposit % skipped (nothing to apply)', v_dep.id;
      CONTINUE;
    END IF;

    v_when  := v_dep.landed_at;
    v_day   := (v_when AT TIME ZONE 'Africa/Kampala')::date;
    v_track := 'TSP-' || substr(gen_random_uuid()::text, 1, 8);

    SELECT COALESCE(SUM(ac.amount), 0) INTO v_paid_day
      FROM public.agent_collections ac
     WHERE ac.rent_request_id = c_rr AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = v_day;
    v_due := CASE WHEN v_daily <= 0 THEN v_out ELSE LEAST(v_out, GREATEST(0, v_daily - v_paid_day)) END;

    v_legs := jsonb_build_array(
      jsonb_build_object(
        'amount', v_applied, 'direction', 'cash_in', 'category', 'tenant_repayment', 'ledger_scope', 'platform',
        'classification', 'production', 'transaction_date', v_when,
        'description', format('Tenant self-payment reduces rent receivable (%s)', COALESCE((SELECT name FROM public.landlords WHERE id = v_rr.landlord_id), 'Unknown')),
        'linked_party', v_rr.landlord_id, 'source_table', 'agent_collections', 'source_id', c_rr, 'reference_id', v_track),
      jsonb_build_object(
        'user_id', c_tenant, 'amount', v_applied, 'direction', 'cash_out', 'category', 'agent_float_used_for_rent',
        'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
        'classification', 'production', 'transaction_date', v_when,
        'description', 'Tenant self-payment settled from own deposited balance',
        'linked_party', v_rr.landlord_id, 'source_table', 'agent_collections', 'source_id', c_rr, 'reference_id', v_track));

    -- Legacy-plan commission (funded before the treasury waterfall went live), exactly as settle_tenant_rent_from_deposit pays it.
    IF NOT public.is_treasury_waterfall_scope(c_rr) AND v_rr.agent_id IS NOT NULL THEN
      v_ctotal := round(v_applied * 0.10, 2);
      IF v_parent IS NOT NULL AND NOT v_white THEN
        v_cagent := round(v_ctotal * 0.80, 2);
        v_cparent := v_ctotal - v_cagent;
      ELSE
        v_cagent := v_ctotal;
        v_cparent := 0;
      END IF;
      IF v_ctotal > 0 THEN
        v_legs := v_legs || jsonb_build_array(
          jsonb_build_object(
            'user_id', v_rr.agent_id, 'amount', v_cagent, 'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
            'classification', 'production', 'transaction_date', v_when,
            'description', 'Agent commission on tenant self-payment (legacy plan)',
            'source_table', 'agent_collections', 'source_id', c_rr, 'reference_id', v_track),
          jsonb_build_object(
            'amount', v_ctotal, 'direction', 'cash_out', 'category', 'agent_commission_payable', 'ledger_scope', 'platform',
            'classification', 'production', 'transaction_date', v_when,
            'description', 'Platform commission expense on tenant self-payment (legacy plan)',
            'source_table', 'agent_collections', 'source_id', c_rr, 'reference_id', v_track));
        IF v_cparent > 0 THEN
          v_legs := v_legs || jsonb_build_array(jsonb_build_object(
            'user_id', v_parent, 'amount', v_cparent, 'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
            'classification', 'production', 'transaction_date', v_when,
            'description', 'Parent override 2% on tenant self-payment (legacy plan)',
            'source_table', 'agent_collections', 'source_id', c_rr, 'reference_id', v_track));
        END IF;
      END IF;
    END IF;

    v_group := public.create_ledger_transaction(v_legs, format('tenant_self_repayment:%s', v_dep.id));

    INSERT INTO public.agent_collections (
      agent_id, tenant_id, rent_request_id, amount, payment_method, float_before, float_after, tracking_id, notes,
      collection_channel, initiated_by, deposit_request_id, performance_weight, expected_amount, shortfall_amount, is_partial, created_at
    ) VALUES (
      v_rr.agent_id, c_tenant, c_rr, v_applied, 'in_app_wallet'::collection_payment_method, v_float, GREATEST(0, v_float - v_applied), v_track,
      'Tenant self-payment from own balance', 'tenant_deposit_auto', c_tenant, v_dep.id, 2,
      NULLIF(v_due, 0), GREATEST(0, v_due - v_applied), v_due > v_applied, v_when
    ) RETURNING id INTO v_col;

    INSERT INTO public.repayments (tenant_id, rent_request_id, amount, payment_method, paid_by, initiated_by, deposit_request_id, external_reference, created_at)
    VALUES (c_tenant, c_rr, v_applied, 'in_app_wallet', c_tenant, c_tenant, v_dep.id, COALESCE(v_dep.transaction_id, v_track), v_when)
    RETURNING id INTO v_rep;

    UPDATE public.rent_requests
       SET amount_repaid = COALESCE(amount_repaid, 0) + v_applied,
           last_payment_amount = v_applied,
           updated_at = now()
     WHERE id = c_rr;

    SELECT p.phone INTO v_phone FROM public.deposit_requests dr JOIN public.profiles p ON p.id = dr.user_id WHERE dr.id = v_dep.id;

    INSERT INTO public.tenant_self_repayment_attempts (
      deposit_request_id, tenant_id, rent_request_id, agent_id, deposit_amount, applied_amount, surplus_amount,
      outcome, reason, paid_from_phone, transaction_group_id, metadata
    ) VALUES (
      v_dep.id, c_tenant, c_rr, v_rr.agent_id, v_dep.amount, v_applied, 0, 'settled', NULL, v_phone, v_group,
      jsonb_build_object('collection_id', v_col, 'repayment_id', v_rep, 'tracking_id', v_track, 'money_source', 'tenant_deposited_float',
                         'applied_from_float', v_applied, 'backfill', '20261021230000_reapply_matovu_sadick_rent_plan_payments',
                         'commission_total', COALESCE(v_ctotal, 0), 'commission_agent', COALESCE(v_cagent, 0),
                         'commission_parent', COALESCE(v_cparent, 0), 'parent_agent_id', v_parent)
    )
    ON CONFLICT (deposit_request_id) DO UPDATE
      SET outcome = 'settled', reason = NULL, tenant_id = EXCLUDED.tenant_id, rent_request_id = EXCLUDED.rent_request_id,
          agent_id = EXCLUDED.agent_id, applied_amount = EXCLUDED.applied_amount, surplus_amount = 0,
          transaction_group_id = EXCLUDED.transaction_group_id, metadata = EXCLUDED.metadata, updated_at = now();

    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, description, metadata, created_at)
    VALUES ('payment_made', c_tenant, 'rent_requests', c_rr, 'Tenant self-payment settled from own balance',
            jsonb_build_object('deposit_request_id', v_dep.id, 'channel', 'tenant_deposit_auto', 'applied_amount', v_applied,
                               'agent_id', v_rr.agent_id, 'settlement_group_id', v_group, 'backfill', true), v_when);

    v_float := v_float - v_applied;
    v_settled := v_settled + 1;
  END LOOP;

  PERFORM public.rent_apply_collections_to_days(c_rr);
  RAISE NOTICE 'matovu fix: % deposits settled onto the plan', v_settled;
END
$fix$;
