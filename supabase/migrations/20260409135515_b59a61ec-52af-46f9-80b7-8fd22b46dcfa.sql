
CREATE OR REPLACE FUNCTION public.validate_treasury_action(
  action_type TEXT,
  p_amount NUMERIC,
  p_user_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total_cash NUMERIC;
  wallet_balance NUMERIC;
  cash_guard_enabled BOOLEAN;
BEGIN
  -- Check if cash guard is enabled
  SELECT enabled INTO cash_guard_enabled
  FROM public.treasury_controls
  WHERE control_key = 'enforce_cash_guard';

  IF cash_guard_enabled IS TRUE THEN
    -- Total platform cash = all cash_in minus all cash_out
    SELECT COALESCE(SUM(
      CASE
        WHEN direction = 'cash_in' THEN amount
        WHEN direction = 'cash_out' THEN -amount
        ELSE 0
      END
    ), 0)
    INTO total_cash
    FROM public.general_ledger;

    IF total_cash < p_amount THEN
      RAISE EXCEPTION 'INSUFFICIENT CASH: available=% requested=%', total_cash, p_amount;
    END IF;
  END IF;

  -- For withdrawals, also check user wallet balance from ledger
  IF action_type = 'withdrawal' AND p_user_id IS NOT NULL THEN
    SELECT COALESCE(SUM(
      CASE
        WHEN direction = 'cash_in' THEN amount
        WHEN direction = 'cash_out' THEN -amount
        ELSE 0
      END
    ), 0)
    INTO wallet_balance
    FROM public.general_ledger
    WHERE user_id = p_user_id
      AND ledger_scope = 'wallet';

    IF wallet_balance < p_amount THEN
      RAISE EXCEPTION 'INSUFFICIENT WALLET: available=% requested=%', wallet_balance, p_amount;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;
