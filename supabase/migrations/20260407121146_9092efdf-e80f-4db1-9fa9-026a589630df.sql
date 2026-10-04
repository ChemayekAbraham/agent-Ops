
-- Resync ALL wallet balances from the general_ledger
-- This fixes wallets that are out of sync due to legacy entries missing transaction_group_id
UPDATE public.wallets w
SET balance = GREATEST(sub.computed_balance, 0),
    updated_at = now()
FROM (
  SELECT 
    gl.user_id,
    COALESCE(SUM(CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE 0 END), 0) -
    COALESCE(SUM(CASE WHEN gl.direction = 'cash_out' THEN gl.amount ELSE 0 END), 0) AS computed_balance
  FROM public.general_ledger gl
  WHERE gl.category NOT IN ('rent_float_funding', 'landlord_float_payout')
  GROUP BY gl.user_id
) sub
WHERE w.user_id = sub.user_id
  AND w.balance != GREATEST(sub.computed_balance, 0);

-- Also update the trigger to NOT skip entries without transaction_group_id
-- This prevents future drift
CREATE OR REPLACE FUNCTION public.sync_wallet_from_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- SKIP float funding entries — these affect agent_landlord_float, NOT personal wallets
  IF NEW.category IN ('rent_float_funding', 'landlord_float_payout') THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.wallets (user_id, balance)
  VALUES (NEW.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  IF NEW.direction = 'cash_in' THEN
    UPDATE public.wallets
    SET balance = balance + NEW.amount, updated_at = now()
    WHERE user_id = NEW.user_id;
  ELSIF NEW.direction = 'cash_out' THEN
    UPDATE public.wallets
    SET balance = GREATEST(balance - NEW.amount, 0), updated_at = now()
    WHERE user_id = NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$;
