
-- Deduct agent wallet immediately when commission payout is REQUESTED (prevents double requests)
CREATE OR REPLACE FUNCTION public.deduct_wallet_on_agent_payout_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_bal NUMERIC;
  new_bal NUMERIC;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
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
      RAISE EXCEPTION 'Balance changed during request (optimistic lock). Please retry.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deduct_wallet_on_agent_payout_request ON public.agent_commission_payouts;
CREATE TRIGGER trg_deduct_wallet_on_agent_payout_request
  BEFORE INSERT ON public.agent_commission_payouts
  FOR EACH ROW
  EXECUTE FUNCTION public.deduct_wallet_on_agent_payout_request();

-- Update agent payout approval: no deduction on approval (already deducted), refund on rejection
CREATE OR REPLACE FUNCTION public.handle_agent_payout_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- On rejection: REFUND the amount back to wallet
  IF NEW.status = 'rejected' AND (OLD.status IS DISTINCT FROM 'rejected') AND OLD.status = 'pending' THEN
    UPDATE public.wallets
    SET balance = balance + NEW.amount, updated_at = NOW()
    WHERE user_id = NEW.agent_id;
  END IF;

  -- On approval: balance already deducted on request, just set processed_at
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'approved') THEN
    NEW.processed_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;
