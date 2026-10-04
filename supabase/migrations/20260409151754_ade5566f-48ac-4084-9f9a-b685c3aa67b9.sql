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

  -- 🔒 ONLY wallet-scoped entries affect user wallets
  -- Platform and bridge entries must NEVER touch wallet balances
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN
    RETURN NEW;
  END IF;

  -- Legacy safety net (redundant with scope guard above)
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