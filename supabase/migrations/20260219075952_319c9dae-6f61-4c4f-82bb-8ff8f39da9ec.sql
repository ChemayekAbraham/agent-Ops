
-- Trigger function to block withdrawals if wallet balance < 50,000
CREATE OR REPLACE FUNCTION public.enforce_minimum_withdrawal_balance()
RETURNS TRIGGER AS $$
DECLARE
  current_balance numeric;
BEGIN
  -- Only enforce on new pending requests
  IF NEW.status = 'pending' THEN
    SELECT balance INTO current_balance
    FROM public.wallets
    WHERE user_id = NEW.user_id;

    IF current_balance IS NULL OR current_balance < 50000 THEN
      RAISE EXCEPTION 'Withdrawal blocked: Your wallet balance must be at least UGX 50,000 to make a withdrawal request. Current balance: %', COALESCE(current_balance, 0);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Attach trigger to withdrawal_requests table
DROP TRIGGER IF EXISTS enforce_min_balance_before_withdrawal ON public.withdrawal_requests;
CREATE TRIGGER enforce_min_balance_before_withdrawal
BEFORE INSERT ON public.withdrawal_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_minimum_withdrawal_balance();
