-- Tenant Self-Payment (Route B) — M3: correct settle_tenant_rent_from_deposit().
--
-- WHAT WAS WRONG (all verified against the LIVE function, not the migration files)
--   1. Money source. It read get_user_wallet_view()->>'float_balance', i.e. A2
--      Agent Float, and refused with 'no_operational_float' when that was zero.
--      A genuine tenant has no operational float, so the route was in practice
--      unusable by tenants: of 233 attempts only 3 ever settled, and both users
--      who settled hold agent roles.
--   2. A3 direction. It posted bridge.rent_receivable_created (DR A3), the
--      pre-G7 disbursement shape, so a rent COLLECTION increased the tenant's
--      receivable while rent_requests.amount_repaid was incremented.
--   3. It bypassed the Landlord Flow waterfall entirely, updating amount_repaid
--      directly. No L7, no L5, no R1, no instalment_allocations.
--
-- The old group balanced on both controls only because errors 1 and 2 offset
-- (CR A2 against DR A3). That is why ledger_mapped_balance_violations never
-- flagged it.
--
-- THE CORRECTED SHAPE — UGX 50,000, in-scope plan
--   Group A  tenant custody settlement
--     DR L1  wallet.tenant_rent_settlement (cash_out, withdrawable)  50,000
--     CR A3  platform.tenant_repayment     (cash_in)                 50,000
--   Group B  post_instalment_waterfall(), unmodified
--     DR L7 / CR L5 / CR R1, amounts computed by the waterfall
--   Group C  commission settlement
--     DR L5  platform.agent_commission_settled (cash_out)
--     CR L1  wallet.agent_commission_earned    (cash_in)  8% collector
--     CR L1  wallet.agent_commission_earned    (cash_in)  2% verified parent
--   A2 NEVER APPEARS.
--
-- LEGACY (pre go-live) PLANS
-- is_treasury_waterfall_scope() is false, so no waterfall runs and no L5 is
-- accrued. Settling L5 there would debit a payable that was never credited, so
-- Group C is skipped and the ORIGINAL X3/L1 commission legs are kept inside
-- Group A instead — unchanged from today's behaviour. Only the cash legs are
-- corrected. This is the "correct the direction without backfilling history"
-- boundary: no historical row is touched, and legacy plans keep legacy
-- commission accounting.
--
-- COMMISSION IS NEVER DOUBLE-COUNTED: in-scope runs use L5 only, legacy runs
-- use X3 only. The two are mutually exclusive on v_in_scope.
--
-- COMMISSION AMOUNT is taken from the waterfall's own `agent_commission` output
-- for in-scope plans (cumulative true-up, drift-free), never recomputed here.
-- Legacy keeps round(applied * 0.10, 2) exactly as before. The 8/2 split is
-- derived so the two halves always sum to the total.
--
-- DAILY INSTALMENT CAP PRESERVED. The live function caps the applied amount at
-- today's remaining daily instalment (shared with the agent collection engine
-- so the same day is not charged twice), not the full outstanding. That cap is
-- retained. Surplus above it stays in the tenant's withdrawable balance either
-- way, which is the overpayment requirement.
--
-- IDENTITY VERIFICATION — SCOPE LIMIT, PLEASE READ.
-- deposit_requests has NO payer MSISDN column; the payer's number is not
-- captured at ingestion anywhere in the schema. True payer-number verification
-- is therefore IMPOSSIBLE today and is NOT claimed here. What is implemented is
-- the strongest check the available data supports: where the depositor has
-- registered deposit numbers in user_deposit_numbers, the profile phone must
-- match one of them (last 9 digits). The verification state is always recorded
-- in the attempt metadata. Capturing the true payer MSISDN on deposit_requests
-- is a separate upstream change and is deliberately not invented here.

CREATE OR REPLACE FUNCTION public.settle_tenant_rent_from_deposit(p_deposit_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_dep            record;
  v_plan           record;
  v_rr             uuid;                 -- BD-A: resolved ONCE, used everywhere
  v_avail          numeric := 0;         -- tenant's own withdrawable
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

  -- Idempotency layer 1: the repayment row carries deposit_request_id under a
  -- unique partial index, so a replayed deposit short-circuits here.
  IF EXISTS (SELECT 1 FROM public.repayments r WHERE r.deposit_request_id = p_deposit_request_id) THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'reason', 'already_settled');
  END IF;

  v_purpose := lower(COALESCE(v_dep.purpose, ''));

  -- IDENTITY (see header for the scope limit).
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

  -- BD-C: eligibility must not depend on holding the agent role. Signup grants
  -- every user the agent role, so this tests whether the depositor actually
  -- OPERATES as an agent (carries float, collects for others). Preserved from
  -- the live function.
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

  -- BD-A: the ONE resolution. Oldest active plan.
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
       AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
           = (now() AT TIME ZONE 'Africa/Kampala')::date;

    v_due := CASE WHEN v_daily <= 0 THEN v_out
                  ELSE LEAST(v_out, GREATEST(0, v_daily - v_paid_today)) END;

    -- THE CORRECTION: the tenant's OWN withdrawable balance, never A2 float.
    -- LEAST() against wallets.withdrawable_balance mirrors the solvency gate
    -- inside create_ledger_transaction so we refuse cleanly instead of raising.
    SELECT COALESCE(withdrawable_balance, 0) INTO v_cached
      FROM public.wallets WHERE user_id = v_dep.user_id;
    v_avail := GREATEST(0, LEAST(
      COALESCE((public.get_user_wallet_view(v_dep.user_id) ->> 'withdrawable')::numeric, 0),
      COALESCE(v_cached, 0)));

    v_applied := round(LEAST(COALESCE(v_dep.amount, 0), v_due, v_avail), 2);

    IF v_out <= 0 THEN
      v_reason := 'plan_already_cleared';
    ELSIF v_due <= 0 THEN
      v_reason := 'daily_amount_already_paid';
    ELSIF v_applied <= 0 THEN
      v_reason := CASE WHEN v_avail <= 0 THEN 'no_withdrawable_balance' ELSE 'nothing_to_apply' END;
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

  -- Commission split participants (resolved for both branches).
  IF v_plan.agent_id IS NOT NULL THEN
    SELECT sa.parent_agent_id INTO v_parent_id
      FROM public.agent_subagents sa
     WHERE sa.sub_agent_id = v_plan.agent_id
       AND sa.status IN ('verified', 'approved', 'accepted')
       AND sa.parent_agent_id <> sa.sub_agent_id
     LIMIT 1;
    v_whitelisted := public.is_subagent_commission_whitelisted(v_plan.agent_id);
  END IF;

  -- ---- GROUP A: tenant custody settlement -------------------------------
  v_legs := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_dep.user_id,
      'amount', v_applied,
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
      'reference_id', v_tracking
    ),
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

  -- LEGACY ONLY: keep the original X3/L1 commission legs, because no waterfall
  -- will run and therefore no L5 payable will exist to settle.
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

  -- Collection row is written before the repayment: the daily-due computation
  -- above and the agent-facing guards both read it in-transaction.
  -- float_before/float_after record the balance the money actually came from,
  -- which for this channel is the tenant's withdrawable, not agent float.
  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes,
    collection_channel, initiated_by, deposit_request_id, performance_weight,
    expected_amount, shortfall_amount, is_partial
  ) VALUES (
    v_plan.agent_id, v_dep.user_id, v_rr, v_applied, 'in_app_wallet'::collection_payment_method,
    v_avail, GREATEST(0, v_avail - v_applied), v_tracking,
    'Tenant self-payment from own withdrawable balance',
    'tenant_deposit_auto', v_dep.user_id, p_deposit_request_id, 2,
    NULLIF(v_due, 0), GREATEST(0, v_due - v_applied), v_due > v_applied
  )
  RETURNING id INTO v_collection_id;

  -- ---- AUTHORITATIVE REPAYMENT + GROUP B (waterfall) --------------------
  -- BD-A: v_rr is passed explicitly so nothing downstream re-resolves the plan.
  -- No direct amount_repaid UPDATE here: the orchestration owns it.
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

  -- Stamp the authoritative repayment row rather than inserting a second one.
  IF v_repayment_id IS NOT NULL THEN
    UPDATE public.repayments
       SET payment_method     = 'in_app_wallet',
           paid_by            = v_dep.user_id,
           initiated_by       = v_dep.user_id,
           deposit_request_id = p_deposit_request_id,
           external_reference = COALESCE(v_dep.transaction_id, v_tracking)
     WHERE id = v_repayment_id;
  END IF;

  -- Presentation fields the authoritative function does not set.
  UPDATE public.rent_requests
     SET last_payment_amount = v_applied,
         status = CASE WHEN status IN ('disbursed','funded','approved') AND status <> 'completed'
                       THEN 'repaying' ELSE status END,
         updated_at = now()
   WHERE id = v_rr
  RETURNING status INTO v_new_status;

  -- ---- GROUP C: settle the L5 payable the waterfall accrued -------------
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

  -- ---- Audit trail: the two/three groups are linked here ----------------
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
      'money_source', 'tenant_withdrawable',
      'withdrawable_before', v_avail,
      'withdrawable_after', GREATEST(0, v_avail - v_applied),
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
      'Hi %s, we received UGX %s and applied UGX %s to your rent. Remaining today UGX %s. Remaining to complete UGX %s.%s Thank you.',
      COALESCE(NULLIF(split_part(COALESCE(v_dep.full_name, ''), ' ', 1), ''), 'there'),
      to_char(COALESCE(v_dep.amount,0), 'FM999,999,999'),
      to_char(v_applied, 'FM999,999,999'),
      to_char(GREATEST(0, v_due - v_applied), 'FM999,999,999'),
      to_char(GREATEST(0, v_out - v_applied), 'FM999,999,999'),
      CASE WHEN v_surplus > 0
           THEN format(' UGX %s stays in your wallet balance.', to_char(v_surplus, 'FM999,999,999'))
           ELSE '' END
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
        'Welile: %s paid their own rent (tenant self-payment). UGX %s recorded, your commission UGX %s. Remaining balance: UGX %s.',
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
    'payment_made', v_dep.user_id, 'rent_requests', v_rr,
    'Tenant self-payment settled from own withdrawable balance',
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
    'outstanding_after', GREATEST(0, v_out - v_applied),
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
    'money_source', 'tenant_withdrawable',
    'performance_weight', 2
  );
END;
$function$;
