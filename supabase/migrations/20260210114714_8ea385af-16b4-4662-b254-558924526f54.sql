
-- Create a trigger function that deducts wallet balance when a withdrawal is approved
CREATE OR REPLACE FUNCTION public.handle_withdrawal_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_bal NUMERIC;
  new_bal NUMERIC;
BEGIN
  -- Only fire when status changes to 'approved'
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'approved') THEN
    -- Get current balance
    SELECT balance INTO current_bal
    FROM public.wallets
    WHERE user_id = NEW.user_id
    FOR UPDATE; -- Row-level lock for concurrency safety

    IF current_bal IS NULL THEN
      RAISE EXCEPTION 'Wallet not found for user %', NEW.user_id;
    END IF;

    IF current_bal < NEW.amount THEN
      RAISE EXCEPTION 'Insufficient balance. Available: %, Requested: %', current_bal, NEW.amount;
    END IF;

    -- Deduct balance (floor at zero)
    new_bal := GREATEST(current_bal - NEW.amount, 0);

    UPDATE public.wallets
    SET balance = new_bal, updated_at = NOW()
    WHERE user_id = NEW.user_id AND balance = current_bal;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Balance changed during approval (optimistic lock). Please retry.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Create the trigger on withdrawal_requests
CREATE TRIGGER on_withdrawal_approved
  BEFORE UPDATE ON public.withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_withdrawal_approval();

-- Also handle agent_commission_payouts the same way
CREATE OR REPLACE FUNCTION public.handle_agent_payout_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_bal NUMERIC;
  new_bal NUMERIC;
BEGIN
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'approved') THEN
    SELECT balance INTO current_bal
    FROM public.wallets
    WHERE user_id = NEW.agent_id
    FOR UPDATE;

    IF current_bal IS NULL THEN
      RAISE EXCEPTION 'Wallet not found for agent %', NEW.agent_id;
    END IF;

    IF current_bal < NEW.amount THEN
      RAISE EXCEPTION 'Insufficient balance. Available: %, Requested: %', current_bal, NEW.amount;
    END IF;

    new_bal := GREATEST(current_bal - NEW.amount, 0);

    UPDATE public.wallets
    SET balance = new_bal, updated_at = NOW()
    WHERE user_id = NEW.agent_id AND balance = current_bal;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Balance changed during approval (optimistic lock). Please retry.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_agent_payout_approved
  BEFORE UPDATE ON public.agent_commission_payouts
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_agent_payout_approval();
