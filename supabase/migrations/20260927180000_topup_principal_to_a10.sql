-- Agent Advance top-up: post the principal to A10, not A1.
--
-- Forward-only. One string literal changes. No historical transaction, no
-- access-fee accounting, no resolver exception, no wallet behaviour, no advance
-- balance, no repayment logic, no Float/A2 and nothing in the 22 September
-- restatement is touched.
--
-- THE DEFECT
-- ----------
-- `apply_advance_topup` posted its platform leg as `rent_disbursement` with
-- `source_table = 'agent_advance_topups'`. The base mapping for
-- `rent_disbursement` is A1 with `debit_when = 'cash_in'`, so a `cash_out` leg
-- CREDITS A1. `sofp_ledger_legs` carries an exception that rescues the
-- disbursement path --
--
--   WHEN sc='platform' AND cat='rent_disbursement' AND src='agent_advance_requests' THEN 'A10'
--
-- -- but it is keyed on the literal source_table, and a top-up uses
-- `agent_advance_topups`. The resolver contains no reference to topups at all,
-- so the leg falls through to the base mapping.
--
-- Result: each top-up resolved to CR A1 + CR L1 -- two credits, no debit. Cash
-- understated and the receivable never raised. Six top-ups of 2026-09-21,
-- UGX 6,500,000, are affected; all six are logged in
-- ledger_mapped_balance_violations with the shape
-- "platform.rent_disbursement->A1/CR + wallet.agent_advance_credit->L1/CR".
--
-- THE FIX
-- -------
-- Use the dedicated category that already exists and is already mapped:
--
--   platform / agent_advance_disbursement -> A10 / debit_when = 'cash_out'
--
-- A `cash_out` leg therefore DEBITS A10. The wallet leg is unchanged and still
-- falls to the generic wallet rule (L1, debit_when = 'cash_out'), so a
-- `cash_in` leg CREDITS L1. The entry becomes DR A10 / CR L1 -- the treatment
-- Josh confirmed and the forensic audit verified.
--
-- No new resolver exception is added, deliberately. The category resolves
-- through a real mapping, which is the point of the prepared matrix;
-- `sofp_ledger_legs` contains no reference to `agent_advance_disbursement`, so
-- there is no duplicate resolution path.
--
-- VERIFIED BEFORE WRITING THIS (rollback-only, against live production)
-- --------------------------------------------------------------------
--   * Posting the proposed shape through the real create_ledger_transaction
--     and applying the resolver's own rules returns exactly:
--         A10 DR 1200000  |  L1 CR 1200000
--   * Group balances; DR A10 = principal; CR L1 = principal.
--   * No A1 leg, no A2 leg; float 8,000 -> 8,000 unchanged.
--   * Wallet leg byte-identical between the old and new shapes.
--   * Advance outstanding unchanged (2,958,823.04 -> 2,958,823.04).
--   * strict_mode = true and `agent_advance_disbursement` is in
--     ledger_category_allowlist(), so validate_ledger_category accepts it --
--     proven by the post succeeding, not assumed.
--   * Residue after every test: zero rows, GL count unchanged.
--
-- TRIGGERS THAT KEY ON THE OLD CATEGORY -- both safe
-- --------------------------------------------------
--   enforce_single_rent_disbursement  short-circuits unless
--       source_table = 'rent_requests'; a top-up already returns immediately.
--   auto_assign_ledger_scope          only acts when ledger_scope IS NULL;
--       this call sets 'platform' explicitly and returns at the first line.
--
-- NOTE for whoever adopts this category next: `agent_advance_disbursement` is
-- NOT in auto_assign_ledger_scope's platform list, so a caller that omits
-- ledger_scope would silently get 'wallet'. Safe here because the scope is
-- explicit.
--
-- DELIBERATELY NOT FIXED HERE
-- ---------------------------
--   * The six historical top-ups already sitting in A1 (6,500,000) stay put --
--     a prior-period reclass gated on the transition-period decision.
--   * The seven May-July top-ups with no GL entry (5,870,000) stay as they are.
--   * Top-up access fee (1,820,000 historically) still posts nothing, because
--     its credit counterpart `agent_advance_fee_revenue` does not exist pending
--     the R1-vs-R2 decision.
--   * `disburse_agent_advance_request` keeps `rent_disbursement` and its
--     resolver exception. Moving it belongs with full matrix activation, when
--     both exceptions retire together.
--
-- Production fingerprint before this change: cef055e3f2bed85c8b31a0a454cbf550

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
        'source_table', 'agent_advance_topups', 'source_id', v_topup_id,
        'description', 'Agent advance top-up disbursed to wallet',
        'currency', 'UGX', 'transaction_date', v_now
      )
    ),
    'advance_topup:' || v_topup_id::text,
    false
  );

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

-- The 4-argument overload was dropped on 2026-09-26 (migration 20260926121000)
-- because it posted no ledger entry at all. Restating the grants so a future
-- DROP + CREATE cannot silently widen them.
REVOKE EXECUTE ON FUNCTION public.apply_advance_topup(uuid, numeric, integer, uuid, text, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.apply_advance_topup(uuid, numeric, integer, uuid, text, boolean) TO authenticated;
