-- Migration 3 of 3: Surface unrouted ledger categories
CREATE TABLE IF NOT EXISTS public.wallet_unrouted_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  category    text NOT NULL,
  direction   text NOT NULL,
  amount      numeric NOT NULL,
  bucket_returned text,
  sign_returned   integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_unrouted_category
  ON public.wallet_unrouted_movements (category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_unrouted_created
  ON public.wallet_unrouted_movements (created_at DESC);

ALTER TABLE public.wallet_unrouted_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can read unrouted wallet movements"
  ON public.wallet_unrouted_movements;

CREATE POLICY "Staff can read unrouted wallet movements"
ON public.wallet_unrouted_movements
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
);

-- Update apply_wallet_movement: same behavior on unrouted categories
-- (no balance movement) but log them so they become observable.
CREATE OR REPLACE FUNCTION public.apply_wallet_movement(
  p_user_id uuid, p_category text, p_amount numeric, p_direction text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_route record;
  v_recover numeric;
  v_remaining numeric;
  v_current_advance numeric;
  v_current_withdrawable numeric;
  v_current_float numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  SELECT * INTO v_route FROM public.wallet_route_for_category(p_category, p_direction);

  -- NEW: log unrouted categories instead of silently returning.
  IF v_route.bucket = 'none' OR v_route.sign = 0 THEN
    BEGIN
      INSERT INTO public.wallet_unrouted_movements (
        user_id, category, direction, amount, bucket_returned, sign_returned
      ) VALUES (
        p_user_id, p_category, p_direction, p_amount, v_route.bucket, v_route.sign
      );
    EXCEPTION WHEN OTHERS THEN
      NULL; -- never block the calling transaction over an audit-table issue
    END;
    RETURN;
  END IF;

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  INSERT INTO public.wallets (user_id, balance) VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT withdrawable_balance, float_balance, advance_balance
    INTO v_current_withdrawable, v_current_float, v_current_advance
    FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF v_route.bucket = 'withdrawable' AND v_route.sign = 1 THEN
    v_recover := LEAST(p_amount, COALESCE(v_current_advance, 0));
    v_remaining := p_amount - v_recover;
    UPDATE public.wallets
      SET advance_balance = advance_balance - v_recover,
          withdrawable_balance = withdrawable_balance + v_remaining,
          balance = (withdrawable_balance + v_remaining) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'withdrawable' AND v_route.sign = -1 THEN
    UPDATE public.wallets
      SET withdrawable_balance = withdrawable_balance - p_amount,
          balance = (withdrawable_balance - p_amount) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'float' AND v_route.sign = 1 THEN
    UPDATE public.wallets
      SET float_balance = float_balance + p_amount,
          balance = withdrawable_balance + (float_balance + p_amount),
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'float' AND v_route.sign = -1 THEN
    UPDATE public.wallets
      SET float_balance = float_balance - p_amount,
          balance = withdrawable_balance + (float_balance - p_amount),
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'advance_credit' THEN
    UPDATE public.wallets
      SET withdrawable_balance = withdrawable_balance + p_amount,
          advance_balance = advance_balance + p_amount,
          balance = (withdrawable_balance + p_amount) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;

  ELSIF v_route.bucket = 'advance_repayment' THEN
    UPDATE public.wallets
      SET withdrawable_balance = withdrawable_balance - p_amount,
          advance_balance = GREATEST(0, advance_balance - p_amount),
          balance = (withdrawable_balance - p_amount) + float_balance,
          updated_at = now()
      WHERE user_id = p_user_id;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.apply_wallet_movement(uuid, text, numeric, text) IS
  'Sole writer to wallet bucket fields. Logs unrouted categories to wallet_unrouted_movements so structural gaps become observable.';