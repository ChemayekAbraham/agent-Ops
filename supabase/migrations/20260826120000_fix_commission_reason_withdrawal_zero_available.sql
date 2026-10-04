-- ============================================================================
-- Fix: "Insufficient funds. Available: UGX 0" on withdrawals whose reason is
--      "Commission payout" (and the other commission reason labels), while the
--      wallet card shows a real positive balance.
--
-- Verified against the live database on 2026-08-26: both gates below still
-- carry the desk-only filter described here.
--
-- ROOT CAUSE
-- ----------
-- Both withdrawal gates -- `submit_withdrawal_request` (the RPC the app calls)
-- and `enforce_withdrawal_ledger_match` (the BEFORE INSERT trigger on
-- `withdrawal_requests`) -- switch to a SEPARATE balance definition purely
-- because of the free-text `reason` label the user picked in the dropdown.
--
-- That commission-specific definition was asymmetric:
--
--   earned    := SUM(agent_commission_earned cash_in)
--                WHERE reference_id LIKE '%-cashout-commission'   <-- desk only
--   withdrawn := SUM(agent_commission_withdrawal
--                    + agent_commission_used_for_rent cash_out)   <-- ALL of them
--   available := GREATEST(0, earned - withdrawn - pending)
--
-- `%-cashout-commission` is written ONLY by `approve-withdrawal` for the 0.5%
-- merchant cash-out desk commission. The ordinary agent commissions -- the 10%
-- rent-collection commission from `agent_allocate_tenant_payment`, the 2%
-- recruiter override, bonuses -- carry a bare transaction-group `reference_id`
-- or none at all, so they were EXCLUDED from `earned` while every commission
-- withdrawal ever made was still subtracted.
--
-- For any agent who earns commission from rent collection rather than the
-- cash-out desk, `earned` = 0, so `available` clamps to 0 and the withdrawal is
-- refused -- even though their ledger-backed withdrawable balance (what the
-- wallet card shows) is positive. Choosing a different reason from the same
-- dropdown let the identical withdrawal through, because that path falls to
-- `get_user_available_balance`. A routing label was silently redefining the
-- money.
--
-- FIX
-- ---
-- The commission branch must never REPLACE the ordinary wallet gate -- it may
-- only RAISE it. `commission_withdrawal_available(uuid)` returns:
--
--   GREATEST( get_user_available_balance(user),          -- the ordinary gate
--             desk_commission_earned
--               - commission_withdrawn
--               - in_flight_commission_requests )        -- the desk sub-ledger
--
-- The desk sub-ledger term is left exactly as it was, so the behaviour it was
-- written for is preserved: `approve-withdrawal` documents that merchant
-- cash-out commission "can be higher than get_user_available_balance() when
-- unrelated wallet activity drained the mixed withdrawable bucket", and a desk
-- agent in that position can still draw it. What changes is that a zero (or
-- small) desk sub-ledger can no longer drag an agent BELOW the balance every
-- other withdrawal reason would have given them. Choosing "Commission payout"
-- is now never worse than choosing any other reason, which is what made this
-- a silent, reason-dependent block.
--
-- No new payout exposure is created: each term is one the system already
-- authorises on its own today.
--
-- NOTE ON SCOPE: this migration deliberately does NOT touch the wallet
-- projection refresh path. The repo carries a dirty-flag deferral model
-- (20260811050458) that was never applied to this database -- production's
-- `wallet_balances_projection` has no `is_dirty`/`dirty_since` column and
-- neither `wallet_projection_read_repair` nor `flush_dirty_wallet_projections`
-- exists there. Anything touching that model must be reconciled against the
-- live schema first, separately from this fix.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.commission_withdrawal_available(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_desk_earned    numeric := 0;
  v_withdrawn      numeric := 0;
  v_pending        numeric := 0;
  v_desk_net       numeric := 0;
  v_wallet_avail   numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  v_wallet_avail := COALESCE(public.get_user_available_balance(p_user_id), 0);

  -- Merchant cash-out desk commission sub-ledger -- UNCHANGED from the original
  -- gate. `%-cashout-commission` is written only by approve-withdrawal for the
  -- 0.5% desk commission leg.
  SELECT COALESCE(SUM(amount), 0)
    INTO v_desk_earned
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND direction = 'cash_in'
    AND category = 'agent_commission_earned'
    AND reference_id LIKE '%-cashout-commission';

  SELECT COALESCE(SUM(amount), 0)
    INTO v_withdrawn
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND direction IN ('cash_out', 'debit')
    AND category IN ('agent_commission_withdrawal', 'agent_commission_used_for_rent');

  SELECT COALESCE(SUM(wr.amount), 0)
    INTO v_pending
  FROM public.withdrawal_requests wr
  WHERE wr.user_id = p_user_id
    AND wr.status IN ('pending','requested','manager_approved','processing','approved')
    AND lower(coalesce(wr.reason, '')) IN (
      'commission payout',
      'cash-out commission',
      'cashout commission',
      'cash-out commission payout',
      'cashout commission payout'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger gl
      WHERE gl.source_table = 'withdrawal_requests'
        AND gl.source_id = wr.id
        AND gl.ledger_scope = 'wallet'
        AND gl.direction IN ('cash_out','debit')
        AND gl.category IN ('agent_commission_withdrawal', 'agent_commission_used_for_rent')
    );

  v_desk_net := GREATEST(0::numeric, v_desk_earned - v_withdrawn - v_pending);

  -- Raise-only: the commission reason can lift the cap for a desk agent whose
  -- mixed bucket was drained, but can never push anyone below the ordinary gate.
  RETURN GREATEST(0::numeric, GREATEST(v_wallet_avail, v_desk_net));
END;
$function$;

REVOKE ALL ON FUNCTION public.commission_withdrawal_available(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commission_withdrawal_available(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.commission_withdrawal_available(uuid) IS
  'Available balance for a withdrawal whose reason is a commission-payout label. Returns GREATEST(get_user_available_balance, merchant-desk commission sub-ledger net of commission debits and in-flight commission requests). Before 2026-08-26 the desk sub-ledger REPLACED the ordinary gate, and because its earned side was filtered to reference_id LIKE ''%-cashout-commission'' while its withdrawn side counted every commission debit, agents whose commission comes from rent collection were forced to UGX 0 and could not withdraw a visibly positive balance. Raise-only by construction. Shared by submit_withdrawal_request and enforce_withdrawal_ledger_match -- change both through this function only.';

-- ---------------------------------------------------------------------------
-- submit_withdrawal_request: unchanged except for the commission branch, which
-- now delegates to commission_withdrawal_available().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_withdrawal_request(
  p_amount numeric,
  p_payout_method text,
  p_mobile_money_number text DEFAULT NULL::text,
  p_mobile_money_name text DEFAULT NULL::text,
  p_mobile_money_provider text DEFAULT NULL::text,
  p_bank_name text DEFAULT NULL::text,
  p_bank_account_number text DEFAULT NULL::text,
  p_bank_account_name text DEFAULT NULL::text,
  p_client_request_id uuid DEFAULT NULL::uuid,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_available      numeric;
  v_method         text  := lower(coalesce(p_payout_method, ''));
  v_provider       text;
  v_new_id         uuid;
  v_client_req_id  uuid := coalesce(p_client_request_id, gen_random_uuid());
  v_existing_id    uuid;
  v_existing_code  text;
  v_payout_code    text;
  v_qr_data        text;
  v_reason         text := nullif(btrim(left(coalesce(p_reason, ''), 200)), '');
  v_is_commission  boolean := lower(coalesce(v_reason, '')) IN (
    'commission payout',
    'cash-out commission',
    'cashout commission',
    'cash-out commission payout',
    'cashout commission payout'
  );
  v_commission_earned    numeric := 0;
  v_commission_withdrawn numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized',
      'message', 'You must be signed in to submit a withdrawal.');
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> floor(p_amount) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_amount',
      'message', 'Amount must be a positive whole number of UGX.');
  END IF;

  IF p_amount < 1000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'amount_below_min',
      'message', 'Minimum withdrawal is UGX 1,000.');
  END IF;

  IF p_amount > 50000000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'amount_above_max',
      'message', 'Maximum withdrawal per request is UGX 50,000,000.');
  END IF;

  IF v_method NOT IN ('mobile_money', 'bank_transfer', 'cash') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_method',
      'message', 'Payout method must be mobile_money, bank_transfer, or cash.');
  END IF;

  IF v_method = 'mobile_money' THEN
    v_provider := lower(coalesce(p_mobile_money_provider, ''));
    IF v_provider NOT IN ('mtn', 'airtel') THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_provider',
        'message', 'Mobile money provider must be MTN or Airtel.');
    END IF;
    IF coalesce(btrim(p_mobile_money_number), '') = ''
       OR coalesce(btrim(p_mobile_money_name), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'missing_momo_details',
        'message', 'Mobile money number and account name are required.');
    END IF;
    IF p_mobile_money_number !~ '^\+?[0-9 ]{9,15}$' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_momo_number',
        'message', 'Mobile money number must be 9-15 digits.');
    END IF;
  ELSIF v_method = 'bank_transfer' THEN
    IF coalesce(btrim(p_bank_name), '') = ''
       OR coalesce(btrim(p_bank_account_number), '') = ''
       OR coalesce(btrim(p_bank_account_name), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'missing_bank_details',
        'message', 'Bank name, account number, and account holder name are required.');
    END IF;
  END IF;

  IF v_is_commission THEN
    v_available := public.commission_withdrawal_available(v_uid);
  ELSE
    v_available := public.get_user_available_balance(v_uid);
  END IF;

  IF v_available IS NULL OR v_available < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'code', 'insufficient_funds',
      'message', format(
        'Insufficient funds. Available: UGX %s, requested: UGX %s.',
        to_char(coalesce(v_available, 0), 'FM999,999,999'),
        to_char(p_amount, 'FM999,999,999')
      ),
      'available', coalesce(v_available, 0)
    );
  END IF;

  SELECT id, payout_code
    INTO v_existing_id, v_existing_code
  FROM public.withdrawal_requests
  WHERE client_request_id = v_client_req_id
    AND user_id = v_uid
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'already_submitted',
      'request_id', v_existing_id,
      'payout_code', v_existing_code,
      'available_after', v_available - p_amount
    );
  END IF;

  IF v_method = 'cash' THEN
    LOOP
      v_payout_code := lpad((floor(random() * 10000))::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.payout_codes
        WHERE code = v_payout_code
          AND status IN ('pending', 'claimed')
      );
    END LOOP;
  END IF;

  INSERT INTO public.withdrawal_requests (
    user_id, amount, status, payout_method,
    mobile_money_number, mobile_money_name, mobile_money_provider,
    bank_name, bank_account_number, bank_account_name,
    client_request_id, initiated_by, payout_code, reason
  ) VALUES (
    v_uid, p_amount, 'pending', v_method,
    CASE WHEN v_method = 'mobile_money' THEN btrim(p_mobile_money_number) END,
    CASE
      WHEN v_method = 'mobile_money' THEN btrim(p_mobile_money_name)
      WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_name)
      ELSE 'Cash Pickup'
    END,
    CASE
      WHEN v_method = 'mobile_money' THEN v_provider
      WHEN v_method = 'bank_transfer' THEN 'bank'
      ELSE 'cash'
    END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_name) END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_number) END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_name) END,
    v_client_req_id, v_uid,
    v_payout_code, v_reason
  )
  RETURNING id INTO v_new_id;

  IF v_method = 'cash' THEN
    v_qr_data := jsonb_build_object(
      'code', v_payout_code,
      'amount', p_amount,
      'userId', v_uid,
      'withdrawalId', v_new_id
    )::text;

    INSERT INTO public.payout_codes (
      withdrawal_request_id, user_id, code, qr_data, amount, status
    ) VALUES (
      v_new_id, v_uid, v_payout_code, v_qr_data, p_amount, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'submitted',
    'request_id', v_new_id,
    'payout_code', v_payout_code,
    'available_after', v_available - p_amount
  );

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'duplicate_pending',
      'message', 'You already have a pending withdrawal with these details. Wait for it to be approved or rejected.');
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden',
      'message', 'Withdrawals from this account must be routed through your assigned agent.');
  WHEN raise_exception THEN
    RETURN jsonb_build_object('success', false, 'code', 'rejected', 'message', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_withdrawal_request(numeric, text, text, text, text, text, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_withdrawal_request(numeric, text, text, text, text, text, text, text, uuid, text) TO authenticated;
-- ---------------------------------------------------------------------------
-- enforce_withdrawal_ledger_match: the BEFORE INSERT trigger on
-- withdrawal_requests carried a second copy of the same asymmetric commission
-- math, so it would have rejected the insert even once the RPC allowed it.
-- It now delegates to the same helper. Trigger bindings are unaffected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_withdrawal_ledger_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available numeric := 0;
  v_reason text := lower(coalesce(NEW.reason, ''));
  v_is_commission boolean := false;
  v_commission_earned numeric := 0;
  v_commission_withdrawn numeric := 0;
  v_pending_commission numeric := 0;
  v_check_user uuid;
  v_is_proxy boolean := false;
BEGIN
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    INSERT INTO public.withdrawal_attempt_failures (
      user_id, attempted_amount, ledger_available, reason, client_request_id
    ) VALUES (
      NEW.user_id, COALESCE(NEW.amount, 0), 0,
      'INVALID_AMOUNT', NEW.client_request_id
    );
    RAISE EXCEPTION 'Invalid withdrawal amount'
      USING ERRCODE = '22023';
  END IF;

  -- Landlord-float payouts: the merchant queue row is fully backed by the
  -- agent_landlord_float row, which landlord-payout-disburse deducts atomically
  -- BEFORE inserting this withdrawal_request. It is NOT paid from the agent's
  -- withdrawable wallet, so the wallet ledger check does not apply.
  IF NEW.landlord_payout_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_is_commission := v_reason IN (
    'commission payout',
    'cash-out commission',
    'cashout commission',
    'cash-out commission payout',
    'cashout commission payout'
  );

  v_is_proxy := (
    NEW.proxy_partner_id IS NOT NULL
    AND NEW.agent_id IS NOT NULL
    AND NEW.agent_id <> NEW.user_id
  );
  v_check_user := CASE WHEN v_is_proxy THEN NEW.agent_id ELSE NEW.user_id END;

  IF v_is_commission THEN
    v_available := public.commission_withdrawal_available(v_check_user);
  ELSE
    SELECT public.get_user_available_balance(v_check_user) INTO v_available;
    v_available := COALESCE(v_available, 0);
  END IF;

  IF NEW.amount > v_available THEN
    INSERT INTO public.withdrawal_attempt_failures (
      user_id, attempted_amount, ledger_available, reason, client_request_id,
      metadata
    ) VALUES (
      NEW.user_id, NEW.amount, v_available,
      CASE WHEN v_is_commission THEN 'COMMISSION_BALANCE_EXCEEDED' ELSE 'LEDGER_MISMATCH' END,
      NEW.client_request_id,
      jsonb_build_object(
        'mobile_money_provider', NEW.mobile_money_provider,
        'mobile_money_number', NEW.mobile_money_number,
        'withdrawal_reason', NEW.reason,
        'is_commission_withdrawal', v_is_commission,
        'is_proxy_withdrawal', v_is_proxy,
        'balance_checked_against_user_id', v_check_user
      )
    );
    RAISE EXCEPTION
      'Ledger mismatch detected. Available: %, requested: %. Transaction aborted.',
      v_available, NEW.amount
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
