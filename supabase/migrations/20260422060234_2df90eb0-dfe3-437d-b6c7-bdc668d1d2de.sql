-- Helper: total amount a user can actually withdraw = withdrawable + advance.
-- Float is operational money (rent disbursement parking, etc.) and stays locked.
CREATE OR REPLACE FUNCTION public.get_withdrawable_total(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(withdrawable_balance, 0) + COALESCE(advance_balance, 0)
  FROM public.wallets
  WHERE user_id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_withdrawable_total(uuid) TO authenticated, service_role;

-- Atomic bucket drain for an approved withdrawal. Drains withdrawable first,
-- then advance for the remainder. Never touches float. Returns the amounts
-- pulled from each bucket so callers can audit.
CREATE OR REPLACE FUNCTION public.drain_withdrawable_buckets(
  p_user_id uuid,
  p_amount numeric
)
RETURNS TABLE(
  drained_withdrawable numeric,
  drained_advance numeric,
  new_withdrawable numeric,
  new_advance numeric,
  new_float numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_w numeric;
  v_a numeric;
  v_f numeric;
  v_from_w numeric;
  v_from_a numeric;
  v_remaining numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'drain amount must be positive';
  END IF;

  SELECT withdrawable_balance, advance_balance, float_balance
    INTO v_w, v_a, v_f
    FROM public.wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

  IF v_w IS NULL THEN
    RAISE EXCEPTION 'wallet not found for user %', p_user_id;
  END IF;

  IF (COALESCE(v_w, 0) + COALESCE(v_a, 0)) < p_amount THEN
    RAISE EXCEPTION 'insufficient withdrawable funds: have %, need %', (v_w + v_a), p_amount;
  END IF;

  v_from_w := LEAST(v_w, p_amount);
  v_remaining := p_amount - v_from_w;
  v_from_a := v_remaining;  -- guaranteed <= v_a by check above

  UPDATE public.wallets
    SET withdrawable_balance = v_w - v_from_w,
        advance_balance = v_a - v_from_a,
        balance = (v_w - v_from_w) + v_f,
        updated_at = now()
    WHERE user_id = p_user_id;

  drained_withdrawable := v_from_w;
  drained_advance := v_from_a;
  new_withdrawable := v_w - v_from_w;
  new_advance := v_a - v_from_a;
  new_float := v_f;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.drain_withdrawable_buckets(uuid, numeric) TO service_role;