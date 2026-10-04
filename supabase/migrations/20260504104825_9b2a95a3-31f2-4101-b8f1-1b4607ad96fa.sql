-- Fix double-guard bug in agent_allocate_tenant_payment.
-- The function had two independent float checks: a cached-wallet check at the top,
-- followed (unconditionally) by a legacy ledger-derived commission guard. Agents
-- with a wallet row would pass the first check but still fail the legacy one,
-- producing the misleading "Locked commission" error even when their cached
-- float was sufficient.
--
-- This rewrite consolidates into a single guard that uses ONLY the cached
-- float bucket when a wallet row exists, and falls back to the ledger
-- derivation strictly when no wallet row is present.

CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
  p_agent_id uuid,
  p_rent_request_id uuid,
  p_amount numeric,
  p_description text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total_wallet           numeric;
  v_commission_raw         numeric;
  v_commission             numeric := 0;
  v_float_balance          numeric;
  v_cached_float           numeric;
  v_has_wallet             boolean := false;
  v_landlord_id            uuid;
  v_current_status         text;
  v_total_repayment        numeric;
  v_amount_repaid          numeric;
  v_outstanding            numeric;
  v_commission_amt         numeric;
  v_txn_group              uuid;
  v_tracking_id            text;
  v_now                    timestamptz := now();
BEGIN
  -- ----- Resolve authoritative float balance -----
  SELECT w.float_balance, true
    INTO v_cached_float, v_has_wallet
    FROM public.wallets w
   WHERE w.user_id = p_agent_id;

  IF v_has_wallet THEN
    -- Cached float_balance is authoritative (sole-writer = apply_wallet_movement).
    -- Commission is segregated into withdrawable_balance, so float is already
    -- net-of-commission. No legacy ledger guard needed.
    v_float_balance := GREATEST(0, COALESCE(v_cached_float, 0));
  ELSE
    -- Legacy fallback for users with no wallet row: derive from ledger.
    SELECT COALESCE(SUM(CASE
        WHEN direction IN ('cash_in','credit') THEN amount
        ELSE -amount END), 0)
      INTO v_total_wallet
      FROM public.general_ledger
     WHERE user_id = p_agent_id AND ledger_scope = 'wallet';

    SELECT COALESCE(SUM(
      CASE
        WHEN direction IN ('cash_in','credit')
          AND category IN (
            'agent_commission_earned','agent_commission','agent_bonus',
            'referral_bonus','proxy_investment_commission',
            'agent_advance_credit','partner_commission'
          )
          AND COALESCE(classification, 'production') <> 'admin_correction'
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

    v_commission    := GREATEST(0, COALESCE(v_commission_raw, 0));
    v_float_balance := GREATEST(0, COALESCE(v_total_wallet, 0) - v_commission);
  END IF;

  -- ----- Single float-sufficiency guard -----
  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format(
        'Insufficient float. Available: UGX %s, Requested: UGX %s. Top up your float to continue.',
        v_float_balance, p_amount
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
  v_txn_group      := gen_random_uuid();
  v_tracking_id    := substr(v_txn_group::text, 1, 8);

  PERFORM public.create_ledger_transaction(
    'agent_tenant_float_allocation',
    jsonb_build_array(
      jsonb_build_object(
        'user_id',      p_agent_id,
        'amount',       p_amount,
        'direction',    'cash_out',
        'category',     'rent_payment_for_tenant',
        'ledger_scope', 'wallet',
        'classification','production',
        'description',  COALESCE(p_description, format('Float allocated to tenant rent — %s', v_tracking_id)),
        'linked_party', v_landlord_id,
        'reference_id', v_txn_group::text,
        'recipient_type','operational_wallet'
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
        'reference_id', v_txn_group::text,
        'recipient_type','user'
      ),
      jsonb_build_object(
        'user_id',      p_agent_id,
        'amount',       v_commission_amt,
        'direction',    'cash_in',
        'category',     'agent_commission_earned',
        'ledger_scope', 'wallet',
        'classification','production',
        'description',  format('10%% commission on float allocation — %s', v_tracking_id),
        'reference_id', v_txn_group::text,
        'recipient_type','user'
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
    'transaction_group', v_txn_group,
    'commission_earned', v_commission_amt,
    'amount_allocated',  p_amount
  );
END;
$function$;