
CREATE OR REPLACE FUNCTION public.enforce_minimum_withdrawal_balance()
RETURNS TRIGGER AS $$
DECLARE
  current_balance NUMERIC;
BEGIN
  IF NEW.status = 'pending' THEN
    SELECT balance INTO current_balance
    FROM public.wallets
    WHERE user_id = NEW.user_id;

    IF current_balance IS NULL OR current_balance < 5000 THEN
      RAISE EXCEPTION 'Withdrawal blocked: Your wallet balance must be at least UGX 5,000 to make a withdrawal request. Current balance: %', COALESCE(current_balance, 0);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
