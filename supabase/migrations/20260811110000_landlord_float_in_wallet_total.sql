-- Make "Total Money in All Wallets" account for agent landlord-payout float.
--
-- Landlord float (agent_landlord_float / agent_landlord_float_allocations) is
-- deliberately NOT part of the agent's own wallet ledger (see
-- src/hooks/useAgentLandlordFloat.ts) — it's locked, earmarked money for
-- paying landlords, not the agent's spendable balance. But it IS real
-- platform-held money, and the hero card was silently excluding it entirely
-- since it only sums general_ledger rows with ledger_scope='wallet', and this
-- pool never writes to general_ledger at all.
--
-- Along the way this surfaced a real, separate bug: deduct_agent_float_for_payout
-- (the function that actually debits float when an agent pays a landlord) writes
-- agent_landlord_float.balance directly but never updates paid_out_amount on the
-- allocation row it drew from. Since balance is ALSO re-derived from
-- SUM(remaining_amount) over allocation rows every time ANY new allocation event
-- fires for that agent (trg_sync_landlord_float_from_allocation, always
-- p_allow_increase=true), the next unrelated CFO funding call for the same agent
-- silently resurrects already-spent float. refund_agent_float_for_payout has the
-- identical bug in reverse. Both are fixed here by recording consumption directly
-- against the allocation at the real point balance changes, and the now-redundant
-- apply_landlord_payout_to_allocation trigger (which only ever fired on a
-- landlord_payouts status transition this flow never reaches) is retired --
-- same pattern already used for credit_float_on_funding (20260730103624_...sql).

-- 1. Record consumption atomically at the real deduction point.
CREATE OR REPLACE FUNCTION public.deduct_agent_float_for_payout(p_payout_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payout public.landlord_payouts%ROWTYPE;
  v_float_balance numeric;
  v_new_balance numeric;
BEGIN
  SELECT * INTO v_payout FROM public.landlord_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout % not found', p_payout_id; END IF;

  IF v_payout.status NOT IN ('otp_verified','pending_merchant_payout','disbursing') THEN
    RAISE EXCEPTION 'Payout % not in deductible status (%)', p_payout_id, v_payout.status;
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float
  WHERE agent_id = v_payout.agent_id
  FOR UPDATE;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent % has no float account', v_payout.agent_id;
  END IF;

  IF v_float_balance < v_payout.amount THEN
    RAISE EXCEPTION 'Insufficient float (balance %, requested %)', v_float_balance, v_payout.amount;
  END IF;

  v_new_balance := v_float_balance - v_payout.amount;

  UPDATE public.agent_landlord_float
  SET balance = v_new_balance,
      total_paid_out = COALESCE(total_paid_out, 0) + v_payout.amount,
      updated_at = now()
  WHERE agent_id = v_payout.agent_id;

  -- Record consumption against the allocation this float came from, so the
  -- derived-balance recompute (SUM(remaining_amount)) agrees with the direct
  -- write above instead of reviving it on the next unrelated funding event.
  UPDATE public.agent_landlord_float_allocations
  SET paid_out_amount = paid_out_amount + v_payout.amount
  WHERE id = (
    SELECT id FROM public.agent_landlord_float_allocations
    WHERE agent_id = v_payout.agent_id
      AND (
        rent_request_id = v_payout.rent_request_id
        OR (rent_request_id IS NULL AND tenant_id IS NOT DISTINCT FROM v_payout.tenant_id)
      )
      AND status IN ('open','partially_paid')
    ORDER BY created_at ASC LIMIT 1
  );

  UPDATE public.landlord_payouts
  SET attempts = attempts + 1,
      last_attempt_at = now()
  WHERE id = p_payout_id;

  RETURN jsonb_build_object('ok', true, 'previous_balance', v_float_balance, 'new_balance', v_new_balance, 'deducted', v_payout.amount);
END;
$function$;

-- 2. Symmetric fix on the refund path -- same bug, in reverse.
CREATE OR REPLACE FUNCTION public.refund_agent_float_for_payout(p_payout_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payout public.landlord_payouts%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(p_reason) < 10 THEN
    RAISE EXCEPTION 'Refund reason must be at least 10 characters';
  END IF;

  SELECT * INTO v_payout FROM public.landlord_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout % not found', p_payout_id; END IF;

  IF v_payout.status = 'completed' THEN
    RAISE EXCEPTION 'Cannot refund a completed payout';
  END IF;

  PERFORM 1 FROM public.agent_landlord_float WHERE agent_id = v_payout.agent_id FOR UPDATE;

  UPDATE public.agent_landlord_float
  SET balance = COALESCE(balance, 0) + v_payout.amount,
      total_paid_out = GREATEST(COALESCE(total_paid_out, 0) - v_payout.amount, 0),
      updated_at = now()
  WHERE agent_id = v_payout.agent_id;

  -- Reverse the consumption recorded by deduct_agent_float_for_payout so a
  -- later recompute doesn't claw the refund back out again.
  UPDATE public.agent_landlord_float_allocations
  SET paid_out_amount = GREATEST(paid_out_amount - v_payout.amount, 0)
  WHERE id = (
    SELECT id FROM public.agent_landlord_float_allocations
    WHERE agent_id = v_payout.agent_id
      AND (
        rent_request_id = v_payout.rent_request_id
        OR (rent_request_id IS NULL AND tenant_id IS NOT DISTINCT FROM v_payout.tenant_id)
      )
      AND paid_out_amount > 0
    ORDER BY updated_at DESC LIMIT 1
  );

  RETURN jsonb_build_object('ok', true, 'refunded', v_payout.amount, 'reason', p_reason);
END;
$function$;

-- 3. Retire the now-redundant trigger logic (only ever fired on a
-- landlord_payouts status transition to 'completed', which the actual
-- deduction flow above -- status 'awaiting_agent_receipt' -- never reaches;
-- keeping it live would double-add paid_out_amount if a row ever does reach
-- 'completed'). Same retirement pattern as credit_float_on_funding.
CREATE OR REPLACE FUNCTION public.apply_landlord_payout_to_allocation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- RETIRED 2026-08-11: consumption is now recorded directly by
  -- deduct_agent_float_for_payout / refund_agent_float_for_payout at the real
  -- point agent_landlord_float.balance changes, not at the later 'completed'
  -- status transition this trigger watched for.
  RETURN NEW;
END;
$$;

-- 4. Fold the landlord-float pool into the wallet-totals cache: hero number,
-- the float sub-bucket, and the strict cross-check identically (so no false
-- "Needs Review" drift is introduced -- landlord float isn't general_ledger-
-- derived, so without matching the strict side it would always look "missing").
CREATE OR REPLACE FUNCTION public.refresh_wallet_totals_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300000'
AS $fn$
DECLARE
  v_total_wallets bigint;
  v_active_wallets bigint;
  v_total_balance numeric;
  v_total_float numeric;
  v_total_withdrawable numeric;
  v_strict_total numeric;
  v_drifted_wallets bigint;
  v_total_drift numeric;
  v_landlord_float_total numeric;
BEGIN
  SELECT COALESCE(SUM(balance), 0) INTO v_landlord_float_total
  FROM public.agent_landlord_float;

  -- Headline totals + wallet count in a single scan of the strict ledger view.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE COALESCE(total_visible, 0) > 0),
    COALESCE(SUM(COALESCE(total_visible, 0)), 0) + v_landlord_float_total,
    COALESCE(SUM(COALESCE(float_balance, 0)), 0) + v_landlord_float_total,
    COALESCE(SUM(COALESCE(withdrawable, 0)), 0)
  INTO v_total_wallets, v_active_wallets, v_total_balance, v_total_float, v_total_withdrawable
  FROM public.v_user_wallet_strict
  WHERE user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid;

  -- Strict ledger + drift totals (mirrors the previous get_wallet_totals_strict body)
  WITH targets AS (
    SELECT
      w.user_id,
      COALESCE(w.balance, 0)::numeric AS cached_balance,
      (COALESCE(t.target_withdrawable, 0) + COALESCE(t.target_float, 0))::numeric AS ledger_cache_target,
      COALESCE(s.total_visible, 0)::numeric AS strict_total_visible
    FROM public.wallets w
    LEFT JOIN LATERAL (
      WITH anchor AS (
        SELECT anchor_at FROM public.wallet_fresh_start_anchors WHERE user_id = w.user_id
      ), ledger AS (
        SELECT gl.category, gl.direction, gl.amount
        FROM public.general_ledger gl
        LEFT JOIN anchor a ON true
        WHERE gl.user_id = w.user_id
          AND gl.ledger_scope = 'wallet'
          AND (gl.classification IS NULL OR gl.classification = 'production')
          AND COALESCE(gl.category, '') <> 'system_balance_correction'
          AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
      )
      SELECT
        GREATEST(0, COALESCE(SUM(CASE
          WHEN COALESCE(category, '') NOT IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
           AND COALESCE(category, '') NOT LIKE 'advance_%'
          THEN CASE WHEN direction = 'cash_in' THEN amount WHEN direction = 'cash_out' THEN -amount ELSE 0 END
          ELSE 0 END), 0))::numeric AS target_withdrawable,
        GREATEST(0, COALESCE(SUM(CASE
          WHEN COALESCE(category, '') IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
          THEN CASE WHEN direction = 'cash_in' THEN amount WHEN direction = 'cash_out' THEN -amount ELSE 0 END
          ELSE 0 END), 0))::numeric AS target_float
      FROM ledger
    ) t ON true
    LEFT JOIN public.v_user_wallet_strict s ON s.user_id = w.user_id
    WHERE w.user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid
  )
  SELECT
    COALESCE(SUM(strict_total_visible), 0) + v_landlord_float_total,
    COUNT(*) FILTER (WHERE ABS(cached_balance - ledger_cache_target) > 100),
    COALESCE(SUM(GREATEST(cached_balance - ledger_cache_target, 0)), 0)
  INTO v_strict_total, v_drifted_wallets, v_total_drift
  FROM targets;

  INSERT INTO public.wallet_totals_cache AS c (
    id, total_wallets, active_wallets, total_balance, total_float, total_withdrawable,
    strict_total, drifted_wallets, total_drift, computed_at
  ) VALUES (
    1, v_total_wallets, v_active_wallets, v_total_balance, v_total_float, v_total_withdrawable,
    v_strict_total, v_drifted_wallets, v_total_drift, now()
  )
  ON CONFLICT (id) DO UPDATE SET
    total_wallets      = EXCLUDED.total_wallets,
    active_wallets     = EXCLUDED.active_wallets,
    total_balance      = EXCLUDED.total_balance,
    total_float        = EXCLUDED.total_float,
    total_withdrawable = EXCLUDED.total_withdrawable,
    strict_total       = EXCLUDED.strict_total,
    drifted_wallets    = EXCLUDED.drifted_wallets,
    total_drift        = EXCLUDED.total_drift,
    computed_at        = EXCLUDED.computed_at;
END;
$fn$;

REVOKE ALL ON FUNCTION public.refresh_wallet_totals_cache() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_wallet_totals_cache() TO service_role;
