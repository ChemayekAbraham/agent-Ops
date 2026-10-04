-- ============================================================================
-- enforce_recipient_routing
-- After a CFO direct credit/debit, guarantee the funds sit in the bucket the
-- operator chose, regardless of what the legacy category-based router did.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_recipient_routing(
  p_user_id        uuid,
  p_amount         numeric,
  p_recipient_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller        uuid;
  v_is_staff      boolean;
  v_withdrawable  numeric;
  v_float         numeric;
  v_to_move       numeric := 0;
  v_from          text;
  v_to            text;
BEGIN
  v_caller := auth.uid();

  -- Allow service_role (no auth.uid()) and staff roles only.
  IF v_caller IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_caller
        AND role IN ('manager','cfo','super_admin')
        AND COALESCE(enabled, true) = true
    ) INTO v_is_staff;
    IF NOT v_is_staff THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
  END IF;

  IF p_recipient_type IS NULL OR p_recipient_type NOT IN ('user','operational_wallet') THEN
    RAISE EXCEPTION 'RECIPIENT_TYPE_REQUIRED';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('moved', 0, 'reason', 'noop_zero_amount');
  END IF;

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  SELECT withdrawable_balance, float_balance
    INTO v_withdrawable, v_float
    FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF v_withdrawable IS NULL THEN
    RETURN jsonb_build_object('moved', 0, 'reason', 'wallet_not_found');
  END IF;

  IF p_recipient_type = 'user' THEN
    -- Make sure at least p_amount is in withdrawable. If float has any of it, move.
    -- We move min(p_amount, current_float) from float -> withdrawable.
    v_to_move := LEAST(p_amount, COALESCE(v_float, 0));
    IF v_to_move > 0 THEN
      UPDATE public.wallets
         SET float_balance        = float_balance - v_to_move,
             withdrawable_balance = withdrawable_balance + v_to_move,
             balance              = (withdrawable_balance + v_to_move) + (float_balance - v_to_move),
             updated_at           = now()
       WHERE user_id = p_user_id;
      v_from := 'float'; v_to := 'withdrawable';
    END IF;

  ELSIF p_recipient_type = 'operational_wallet' THEN
    v_to_move := LEAST(p_amount, COALESCE(v_withdrawable, 0));
    IF v_to_move > 0 THEN
      UPDATE public.wallets
         SET withdrawable_balance = withdrawable_balance - v_to_move,
             float_balance        = float_balance + v_to_move,
             balance              = (withdrawable_balance - v_to_move) + (float_balance + v_to_move),
             updated_at           = now()
       WHERE user_id = p_user_id;
      v_from := 'withdrawable'; v_to := 'float';
    END IF;
  END IF;

  IF v_to_move > 0 THEN
    INSERT INTO public.wallet_routing_v2_corrections (
      user_id, amount_moved, from_bucket, to_bucket, source_categories, notes
    ) VALUES (
      p_user_id, v_to_move, v_from, v_to, ARRAY['cfo_direct_credit_recipient_enforcement'],
      format('Recipient-type enforcement after CFO credit/debit (recipient_type=%s)', p_recipient_type)
    );
  END IF;

  RETURN jsonb_build_object(
    'moved', v_to_move,
    'from', v_from,
    'to',   v_to,
    'recipient_type', p_recipient_type
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.enforce_recipient_routing(uuid, numeric, text) TO authenticated, service_role;