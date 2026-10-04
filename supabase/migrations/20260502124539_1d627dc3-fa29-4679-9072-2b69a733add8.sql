-- Patch agent_allocate_tenant_payment so that admin_correction-classified
-- debits (post-hoc reconciliation entries) never reduce the commission pool.
-- Real commission spend is ALWAYS classification='production'.
CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
  p_agent_id uuid,
  p_rent_request_id uuid,
  p_amount numeric,
  p_description text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_wallet           numeric;
  v_commission_raw         numeric;
  v_commission             numeric;
  v_float_balance          numeric;
  v_landlord_id            uuid;
  v_current_status         text;
  v_total_repayment        numeric;
  v_amount_repaid          numeric;
  v_outstanding            numeric;
  v_self_heal_group        uuid;
  v_cache_delta            numeric;
  v_wallet_cached          numeric;
  v_commission_amt         numeric;
  v_txn_group              uuid;
  v_new_status             text;
  v_now                    timestamptz := now();
BEGIN
  -- ----- Wallet ledger total -----
  SELECT COALESCE(SUM(CASE
      WHEN direction IN ('cash_in','credit') THEN amount
      ELSE -amount END), 0)
    INTO v_total_wallet
    FROM public.general_ledger
   WHERE user_id = p_agent_id AND ledger_scope = 'wallet';

  -- ----- Phantom wallet self-heal (cache > ledger by > 1 UGX) -----
  SELECT COALESCE(balance, 0) INTO v_wallet_cached
    FROM public.wallets WHERE user_id = p_agent_id;

  v_cache_delta := COALESCE(v_wallet_cached, 0) - COALESCE(v_total_wallet, 0);
  IF v_cache_delta > 1 THEN
    v_self_heal_group := gen_random_uuid();
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id',       p_agent_id,
          'amount',        v_cache_delta,
          'direction',     'cash_in',
          'category',      'system_balance_correction',
          'ledger_scope',  'wallet',
          'classification','admin_correction',
          'description',   'Phantom balance auto-heal credit for ' || p_agent_id::text,
          'reference_id',  'autoheal_' || v_self_heal_group::text
        ),
        jsonb_build_object(
          'user_id',       p_agent_id,
          'amount',        v_cache_delta,
          'direction',     'cash_out',
          'category',      'phantom_writedown_clearing',
          'ledger_scope',  'platform',
          'classification','admin_correction',
          'description',   'Phantom balance restored (auto-heal) for ' || p_agent_id::text,
          'reference_id',  'autoheal_' || v_self_heal_group::text
        )
      )
    );
    SELECT COALESCE(SUM(CASE
        WHEN direction IN ('cash_in','credit') THEN amount
        ELSE -amount END), 0)
      INTO v_total_wallet
      FROM public.general_ledger
     WHERE user_id = p_agent_id AND ledger_scope = 'wallet';
  END IF;

  -- ----- Commission accounting (admin_correction debits EXCLUDED) -----
  SELECT COALESCE(SUM(
    CASE
      WHEN direction IN ('cash_in','credit')
        AND category IN (
          'agent_commission_earned','agent_commission','agent_bonus',
          'referral_bonus','proxy_investment_commission',
          'agent_advance_credit','partner_commission'
        )
      THEN amount
      WHEN direction IN ('cash_out','debit')
        AND category IN (
          'agent_commission_withdrawal','agent_commission_used_for_rent',
          'wallet_withdrawal','wallet_transfer','wallet_deduction',
          'wallet_deduction_general_adjustment'
        )
        AND COALESCE(classification, 'production') <> 'admin_correction'
      THEN -amount
      ELSE 0
    END
  ), 0)
  INTO v_commission_raw
  FROM public.general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  IF v_commission_raw < 0 THEN
    INSERT INTO public.wallet_commission_drift (
      user_id, raw_commission, total_wallet_ledger, attempted_amount, context
    ) VALUES (
      p_agent_id, v_commission_raw, v_total_wallet, p_amount,
      'agent_allocate_tenant_payment'
    );

    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'COMMISSION_LEDGER_INCONSISTENT',
      'error', format(
        'Float allocation paused — your commission ledger is out of balance (raw: %s). Support has been notified.',
        v_commission_raw
      )
    );
  END IF;

  v_commission := GREATEST(0, v_commission_raw);
  v_float_balance := GREATEST(0, v_total_wallet - v_commission);

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format(
        'Float allocation blocked — would require commission funds. Available float: %s, Requested: %s, Locked commission: %s. Commission cannot be used for tenant payments.',
        v_float_balance, p_amount, v_commission
      )
    );
  END IF;

  -- ----- Rent request lookup -----
  SELECT
    landlord_id,
    status,
    COALESCE(total_repayment, 0),
    COALESCE(amount_repaid, 0),
    GREATEST(0, COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0))
  INTO
    v_landlord_id,
    v_current_status,
    v_total_repayment,
    v_amount_repaid,
    v_outstanding
  FROM public.rent_requests
  WHERE id = p_rent_request_id;

  IF v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object('success', false,
      'error', format('Amount exceeds outstanding balance (%s).', v_outstanding));
  END IF;

  -- ----- Post the float→landlord transfer + 10% commission -----
  v_commission_amt := round(p_amount * 0.10);
  v_txn_group := gen_random_uuid();

  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id',      p_agent_id,
        'amount',       p_amount,
        'direction',    'cash_out',
        'category',     'rent_payment_for_tenant',
        'ledger_scope', 'wallet',
        'classification','production',
        'description',  COALESCE(p_description, 'Float allocated to tenant rent'),
        'linked_party', v_landlord_id,
        'reference_id', v_txn_group::text
      ),
      jsonb_build_object(
        'user_id',      v_landlord_id,
        'amount',       p_amount,
        'direction',    'cash_in',
        'category',     'rent_payment_received',
        'ledger_scope', 'wallet',
        'classification','production',
        'description',  'Tenant rent received via agent float',
        'linked_party', p_agent_id,
        'reference_id', v_txn_group::text
      ),
      jsonb_build_object(
        'user_id',      p_agent_id,
        'amount',       v_commission_amt,
        'direction',    'cash_in',
        'category',     'agent_commission_earned',
        'ledger_scope', 'wallet',
        'classification','production',
        'description',  format('10%% commission on float allocation — %s', v_txn_group::text),
        'reference_id', v_txn_group::text
      ),
      jsonb_build_object(
        'user_id',      p_agent_id,
        'amount',       v_commission_amt,
        'direction',    'cash_out',
        'category',     'agent_commission_payable',
        'ledger_scope', 'platform',
        'classification','production',
        'description',  'Platform commission payout (10%)',
        'reference_id', v_txn_group::text
      )
    )
  );

  -- Update rent_requests
  UPDATE public.rent_requests
     SET amount_repaid = COALESCE(amount_repaid, 0) + p_amount,
         status = CASE
           WHEN COALESCE(amount_repaid, 0) + p_amount >= COALESCE(total_repayment, 0)
             THEN 'completed' ELSE status END,
         updated_at = v_now
   WHERE id = p_rent_request_id;

  RETURN jsonb_build_object(
    'success', true,
    'amount_allocated', p_amount,
    'commission', v_commission_amt,
    'txn_group', v_txn_group
  );
END;
$$;