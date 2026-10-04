
DROP FUNCTION IF EXISTS public.get_agent_split_balances(uuid);

ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS withdrawable_balance numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS float_balance numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_balance numeric NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_buckets_nonneg') THEN
    ALTER TABLE public.wallets
      ADD CONSTRAINT wallets_buckets_nonneg
      CHECK (withdrawable_balance >= 0 AND float_balance >= 0 AND advance_balance >= 0);
  END IF;
END$$;

CREATE OR REPLACE FUNCTION public.wallet_route_for_category(
  p_category text,
  p_direction text
) RETURNS TABLE(bucket text, sign int)
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_direction IN ('credit', 'cash_in') THEN
    IF p_category IN (
      'wallet_deposit', 'wallet_transfer', 'cfo_direct_credit',
      'agent_commission_earned', 'agent_commission', 'agent_bonus',
      'partner_commission', 'referral_bonus', 'proxy_investment_commission',
      'salary_payout', 'roi_payout'
    ) THEN
      RETURN QUERY SELECT 'withdrawable'::text, 1;
      RETURN;
    END IF;
    IF p_category IN (
      'agent_float_deposit', 'agent_float_assignment', 'agent_float_topup',
      'agent_float_funding'
    ) THEN
      RETURN QUERY SELECT 'float'::text, 1;
      RETURN;
    END IF;
    IF p_category IN ('agent_advance_credit', 'salary_advance') THEN
      RETURN QUERY SELECT 'advance_credit'::text, 1;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'none'::text, 0;
    RETURN;
  END IF;

  IF p_direction IN ('debit', 'cash_out') THEN
    IF p_category IN (
      'wallet_withdrawal', 'agent_commission_withdrawal',
      'agent_commission_used_for_rent', 'wallet_transfer'
    ) THEN
      RETURN QUERY SELECT 'withdrawable'::text, -1;
      RETURN;
    END IF;
    IF p_category IN (
      'agent_float_used_for_rent', 'rent_disbursement',
      'agent_float_used', 'agent_landlord_payout'
    ) THEN
      RETURN QUERY SELECT 'float'::text, -1;
      RETURN;
    END IF;
    IF p_category IN ('agent_advance_repayment', 'salary_advance_repayment', 'debt_recovery') THEN
      RETURN QUERY SELECT 'advance_repayment'::text, -1;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'none'::text, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'none'::text, 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_wallet_movement(
  p_user_id uuid,
  p_category text,
  p_amount numeric,
  p_direction text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  IF v_route.bucket = 'none' OR v_route.sign = 0 THEN RETURN; END IF;

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
$$;

CREATE OR REPLACE FUNCTION public.tr_general_ledger_route_buckets()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  PERFORM public.apply_wallet_movement(NEW.user_id, NEW.category, NEW.amount, NEW.direction);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS general_ledger_route_buckets ON public.general_ledger;
CREATE TRIGGER general_ledger_route_buckets
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_general_ledger_route_buckets();

CREATE OR REPLACE FUNCTION public.recompute_wallet_buckets(p_user_id uuid)
RETURNS TABLE(withdrawable numeric, float_bal numeric, advance numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_w numeric := 0;
  v_f numeric := 0;
  v_a numeric := 0;
  r record;
  v_route record;
  v_recover numeric;
BEGIN
  FOR r IN
    SELECT category, direction, amount
    FROM public.general_ledger
    WHERE user_id = p_user_id AND ledger_scope = 'wallet'
    ORDER BY created_at ASC, id ASC
  LOOP
    SELECT * INTO v_route FROM public.wallet_route_for_category(r.category, r.direction);
    IF v_route.bucket = 'withdrawable' AND v_route.sign = 1 THEN
      v_recover := LEAST(r.amount, v_a);
      v_a := v_a - v_recover;
      v_w := v_w + (r.amount - v_recover);
    ELSIF v_route.bucket = 'withdrawable' AND v_route.sign = -1 THEN
      v_w := v_w - r.amount;
    ELSIF v_route.bucket = 'float' AND v_route.sign = 1 THEN
      v_f := v_f + r.amount;
    ELSIF v_route.bucket = 'float' AND v_route.sign = -1 THEN
      v_f := v_f - r.amount;
    ELSIF v_route.bucket = 'advance_credit' THEN
      v_w := v_w + r.amount;
      v_a := v_a + r.amount;
    ELSIF v_route.bucket = 'advance_repayment' THEN
      v_w := v_w - r.amount;
      v_a := GREATEST(0, v_a - r.amount);
    END IF;
  END LOOP;

  v_w := GREATEST(0, v_w);
  v_f := GREATEST(0, v_f);
  v_a := GREATEST(0, v_a);

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  INSERT INTO public.wallets (user_id, balance) VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.wallets
    SET withdrawable_balance = v_w,
        float_balance = v_f,
        advance_balance = v_a,
        balance = v_w + v_f,
        updated_at = now()
    WHERE user_id = p_user_id;

  RETURN QUERY SELECT v_w, v_f, v_a;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_agent_split_balances(p_agent_id uuid)
RETURNS TABLE(float_balance numeric, commission_balance numeric, withdrawable_balance numeric, advance_balance numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(w.float_balance, 0),
    COALESCE(w.withdrawable_balance, 0),
    COALESCE(w.withdrawable_balance, 0),
    COALESCE(w.advance_balance, 0)
  FROM public.wallets w
  WHERE w.user_id = p_agent_id;
$$;

DO $$
DECLARE
  r record;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  FOR r IN SELECT user_id FROM public.wallets LOOP
    PERFORM public.recompute_wallet_buckets(r.user_id);
  END LOOP;
END$$;
