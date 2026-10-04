-- Add a trigger as a safety net to floor balance at 0 before the CHECK constraint rejects it
CREATE OR REPLACE FUNCTION public.enforce_non_negative_balance()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.balance < 0 THEN
    NEW.balance := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS enforce_wallet_balance_floor ON public.wallets;

CREATE TRIGGER enforce_wallet_balance_floor
BEFORE INSERT OR UPDATE ON public.wallets
FOR EACH ROW
EXECUTE FUNCTION public.enforce_non_negative_balance();
