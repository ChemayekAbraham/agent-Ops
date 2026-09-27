-- Agent Advance top-up: re-key the principal receivable leg so the top-up is
-- visible to agent_advance_component_state().
--
-- NOT YET APPLIED.
--
-- WHY
-- ---
-- The category was already corrected on 2026-09-27 (73c6427335, "post the
-- principal to A10, not A1"), but the leg is still stamped
-- source_table = 'agent_advance_topups' / source_id = v_topup_id, while
-- agent_advance_component_state() filters
-- source_table = 'agent_advances' AND source_id = <advance id>.
-- So a top-up's principal is invisible to the component state, and under the
-- approved waterfall the topped-up advance would under-report its principal
-- component by the top-up amount.
--
-- WHAT CHANGES
-- ------------
-- Exactly two tokens, on the PLATFORM leg of the principal group only:
--     'source_table', 'agent_advance_topups', 'source_id', v_topup_id
--  -> 'source_table', 'agent_advances',       'source_id', a.id
-- The account treatment is untouched: DR A10 / CR L1, same amount, same
-- direction, same category.
--
-- No registration fee is added. The registration fee is charged once, at
-- origination (see 20260927300000); a top-up extends an existing advance and
-- does not re-charge it.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- The WALLET leg keeps its existing source stamping
-- ('agent_advance_topups' / v_topup_id) as well as its category, amount,
-- direction, bucket, recipient_type and description -- the money the agent
-- receives is identical. The access fee block is unchanged (it already uses
-- 'agent_advances' / a.id). No cash, bank or mobile money moves. No tenant,
-- rent or landlord logic. No repayment logic. No historical top-up is
-- altered; there is no opening balance or plug.
--
-- A transaction group may legitimately carry different source_table values on
-- different legs -- the group-balance and mapped-balance constraint triggers
-- key on transaction_group_id, not on source_table. Verified in the sandbox:
-- the re-keyed group balances and produces no mapped-balance violation.
--
-- Production definition before this change: 91ca67a0a33c4e8d7565312b2b9b54a7
--   (179 non-comment body lines)

CREATE OR REPLACE FUNCTION public.apply_advance_topup(p_advance_id uuid, p_amount numeric, p_extend_days integer, p_request_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_override_eligibility boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a public.agent_advances;
  v_elig jsonb;
  v_fee numeric;
  v_new_principal numeric;
  v_new_access_fee numeric;
  v_new_outstanding numeric;
  v_new_cycle integer;
  v_new_expires timestamptz;
  v_period integer;
  v_remaining_installments integer;
  v_installment numeric;
  v_days_elapsed integer;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_is_exec boolean;
  v_topup_id uuid;
  v_group uuid;
  v_now timestamptz := now();
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'super_admin') OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised to apply advance top-ups.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_is_exec := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin');

  SELECT * INTO a FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'Advance not found.';
  END IF;

  IF COALESCE(p_extend_days,0) <= 0 THEN
    RAISE EXCEPTION 'Extension days must be greater than zero.';
  END IF;

  IF p_override_eligibility THEN
    IF NOT v_is_exec THEN
      RAISE EXCEPTION 'Only the CFO, a manager or a super admin can top up outside the standard eligibility rules.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_reason IS NULL OR length(v_reason) < 10 THEN
      RAISE EXCEPTION 'A reason of at least 10 characters is required for this top-up.';
    END IF;
    IF a.status NOT IN ('active','repaying','overdue','paused') THEN
      RAISE EXCEPTION 'Only an open advance can be topped up (current status: %).', a.status;
    END IF;
    IF COALESCE(a.outstanding_balance,0) <= 0 THEN
      RAISE EXCEPTION 'This advance is already fully repaid and cannot be topped up.';
    END IF;
    IF p_amount < 10000 THEN
      RAISE EXCEPTION 'Top-up must be at least UGX 10,000.';
    END IF;
    IF p_amount > COALESCE(a.principal,0) THEN
      RAISE EXCEPTION 'Top-up cannot exceed the current advance principal (UGX %).', COALESCE(a.principal,0);
    END IF;
  ELSE
    v_elig := public.agent_advance_topup_eligibility(a.agent_id);
    IF NOT (v_elig->>'eligible')::boolean THEN
      RAISE EXCEPTION 'Top-up rejected: %', COALESCE(v_elig->>'reason','not eligible');
    END IF;
    IF (v_elig->>'advance_id')::uuid <> a.id THEN
      RAISE EXCEPTION 'Top-up target is not the agent''s current ongoing advance.';
    END IF;
    IF p_amount < (v_elig->>'min_topup')::numeric OR p_amount > (v_elig->>'max_topup')::numeric THEN
      RAISE EXCEPTION 'Top-up amount must be between UGX % and UGX %.',
        (v_elig->>'min_topup'), (v_elig->>'max_topup');
    END IF;
  END IF;

  v_fee := round(p_amount * (power(1 + COALESCE(a.monthly_rate, 0.33), p_extend_days::numeric / 30) - 1));

  v_new_principal   := COALESCE(a.principal,0) + p_amount;
  v_new_access_fee  := COALESCE(a.access_fee,0) + v_fee;
  v_new_outstanding := COALESCE(a.outstanding_balance,0) + p_amount + v_fee;
  v_new_cycle       := COALESCE(a.cycle_days,30) + p_extend_days;
  v_new_expires     := GREATEST(a.expires_at, now()) + make_interval(days => p_extend_days);

  v_period := public.advance_period_days(a.repayment_frequency);
  v_days_elapsed := GREATEST(0, ((now() AT TIME ZONE 'Africa/Kampala')::date
                                 - (a.issued_at AT TIME ZONE 'Africa/Kampala')::date));
  v_remaining_installments := GREATEST(
    1,
    ceil(GREATEST(1, v_new_cycle - v_days_elapsed)::numeric / v_period)
  );
  v_installment := ceil(v_new_outstanding / v_remaining_installments);

  PERFORM set_config('app.advance_topup_in_progress', a.id::text, true);

  UPDATE public.agent_advances
  SET principal = v_new_principal,
      access_fee = v_new_access_fee,
      outstanding_balance = v_new_outstanding,
      cycle_days = v_new_cycle,
      expires_at = v_new_expires,
      installment_amount = v_installment,
      daily_installment = CASE WHEN a.repayment_frequency = 'daily' THEN v_installment ELSE a.daily_installment END,
      status = 'active',
      updated_at = now()
  WHERE id = a.id;

  INSERT INTO public.agent_advance_topups (advance_id, amount, topped_up_by, extend_days, request_id, access_fee_added, reason)
  VALUES (a.id, p_amount, COALESCE(auth.uid(), a.issued_by), p_extend_days, p_request_id, v_fee, v_reason)
  RETURNING id INTO v_topup_id;

  -- The WALLET leg is unchanged, including its source stamping, so the money
  -- the agent receives is identical.
  --
  -- The PLATFORM leg is re-keyed to 'agent_advances' / a.id so the top-up's
  -- principal is visible to agent_advance_component_state(), which filters on
  -- that pair. The account treatment (DR A10 / CR L1), amount, direction and
  -- category are all unchanged.
  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', a.agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', p_amount, 'category', 'agent_advance_credit',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'agent_advance_topups', 'source_id', v_topup_id,
        'description', 'Agent advance top-up - extended ' || p_extend_days || 'd',
        'currency', 'UGX', 'transaction_date', v_now
      ),
      jsonb_build_object(
        'user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', p_amount, 'category', 'agent_advance_disbursement',
        'source_table', 'agent_advances', 'source_id', a.id,
        'description', 'Agent advance top-up disbursed to wallet',
        'currency', 'UGX', 'transaction_date', v_now
      )
    ),
    'advance_topup:' || v_topup_id::text,
    false
  );

  -- Access fee recognised in full at top-up (CFO decision 2026-09-27).
  -- Its OWN transaction group, so the principal group above is unchanged.
  --   platform agent_advance_access_fee_charged cash_out -> DR A11
  --   platform agent_advance_fee_revenue        cash_in  -> CR R2
  -- No wallet leg: the fee is baked into the repayment schedule, never debited
  -- from the wallet. v_fee is the amount actually charged and stored on
  -- agent_advance_topups.access_fee_added; it is never recomputed.
  IF v_fee > 0 THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
          'amount', v_fee, 'category', 'agent_advance_access_fee_charged',
          'source_table', 'agent_advances', 'source_id', a.id,
          'description', 'Agent Advance access fee charged on top-up',
          'currency', 'UGX', 'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_fee, 'category', 'agent_advance_fee_revenue',
          'source_table', 'agent_advances', 'source_id', a.id,
          'description', 'Agent Advance access fee revenue (top-up)',
          'currency', 'UGX', 'transaction_date', v_now
        )
      ),
      'advance_topup_fee:' || v_topup_id::text,
      false
    );
  END IF;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('funds_added', a.agent_id, 'agent_advances', a.id,
    jsonb_build_object('topup_id', v_topup_id, 'advance_id', a.id, 'amount', p_amount,
                       'extend_days', p_extend_days, 'reason', v_reason,
                       'override', p_override_eligibility, 'actor_id', auth.uid(),
                       'description', 'Agent advance top-up'));

  IF p_override_eligibility AND auth.uid() IS NOT NULL THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 'advance_topup_override', 'agent_advances', a.id::text, v_reason,
      jsonb_build_object('topup_id', v_topup_id, 'amount', p_amount, 'extend_days', p_extend_days,
                         'access_fee_added', v_fee, 'new_principal', v_new_principal,
                         'new_outstanding', v_new_outstanding, 'transaction_group_id', v_group));
  END IF;

  RETURN jsonb_build_object(
    'advance_id', a.id,
    'topup_id', v_topup_id,
    'transaction_group_id', v_group,
    'agent_id', a.agent_id,
    'topup_amount', p_amount,
    'access_fee_added', v_fee,
    'new_principal', v_new_principal,
    'new_outstanding', v_new_outstanding,
    'new_cycle_days', v_new_cycle,
    'new_expires_at', v_new_expires,
    'new_installment', v_installment,
    'repayment_frequency', a.repayment_frequency,
    'monthly_rate', a.monthly_rate,
    'reason', v_reason,
    'override', p_override_eligibility
  );
END;
$function$;
