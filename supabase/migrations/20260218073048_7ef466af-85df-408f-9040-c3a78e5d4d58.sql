
-- 1. Update verification bonus from 10,000 to 5,000 UGX
-- (Agent now earns: 5,000 approval + 5,000 verification = 10,000 total per tenant cycle)
CREATE OR REPLACE FUNCTION public.credit_agent_verification_bonus()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id UUID;
  v_already_paid BOOLEAN;
BEGIN
  -- Only when fund_routed_at changes from NULL to a value
  IF OLD.fund_routed_at IS NOT NULL OR NEW.fund_routed_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get the agent who verified this request
  SELECT agent_id INTO v_agent_id FROM public.agent_verifications 
  WHERE rent_request_id = NEW.id AND overall_match = true
  LIMIT 1;

  IF v_agent_id IS NULL THEN
    v_agent_id := NEW.agent_id;
  END IF;

  IF v_agent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if bonus already paid
  SELECT EXISTS (
    SELECT 1 FROM public.agent_earnings 
    WHERE agent_id = v_agent_id AND rent_request_id = NEW.id AND earning_type = 'verification_bonus'
  ) INTO v_already_paid;

  IF v_already_paid THEN
    RETURN NEW;
  END IF;

  -- Credit UGX 5,000 to agent wallet (changed from 10,000)
  UPDATE public.wallets SET balance = balance + 5000 WHERE user_id = v_agent_id;

  -- Record earning
  INSERT INTO public.agent_earnings (agent_id, amount, earning_type, rent_request_id, description)
  VALUES (v_agent_id, 5000, 'verification_bonus', NEW.id, 'Rent verification bonus - landlord received rent');

  -- Notify agent
  INSERT INTO public.notifications (user_id, title, message, type)
  VALUES (v_agent_id, 'Verification Bonus!', 'You earned UGX 5,000 for verifying a tenant whose landlord has received rent.', 'earning');

  RETURN NEW;
END;
$$;

-- 2. Deduct wallet balance immediately when withdrawal is REQUESTED (not on approval)
-- This prevents double withdrawal requests
CREATE OR REPLACE FUNCTION public.deduct_wallet_on_withdrawal_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_bal NUMERIC;
  new_bal NUMERIC;
BEGIN
  -- Only on new INSERT with status 'pending'
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    -- Get current balance with row lock
    SELECT balance INTO current_bal
    FROM public.wallets
    WHERE user_id = NEW.user_id
    FOR UPDATE;

    IF current_bal IS NULL THEN
      RAISE EXCEPTION 'Wallet not found for user %', NEW.user_id;
    END IF;

    IF current_bal < NEW.amount THEN
      RAISE EXCEPTION 'Insufficient balance. Available: %, Requested: %', current_bal, NEW.amount;
    END IF;

    -- Deduct balance immediately
    new_bal := GREATEST(current_bal - NEW.amount, 0);

    UPDATE public.wallets
    SET balance = new_bal, updated_at = NOW()
    WHERE user_id = NEW.user_id AND balance = current_bal;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Balance changed during request (optimistic lock). Please retry.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Create trigger for immediate deduction on request
DROP TRIGGER IF EXISTS trg_deduct_wallet_on_withdrawal_request ON public.withdrawal_requests;
CREATE TRIGGER trg_deduct_wallet_on_withdrawal_request
  BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.deduct_wallet_on_withdrawal_request();

-- 3. Update the existing approval trigger to NOT deduct again (since already deducted on request)
-- Instead, on REJECTION, refund the amount back to the wallet
CREATE OR REPLACE FUNCTION public.handle_withdrawal_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_bal NUMERIC;
BEGIN
  -- On rejection: REFUND the amount back to wallet
  IF NEW.status = 'rejected' AND (OLD.status IS DISTINCT FROM 'rejected') AND OLD.status = 'pending' THEN
    UPDATE public.wallets
    SET balance = balance + NEW.amount, updated_at = NOW()
    WHERE user_id = NEW.user_id;
  END IF;

  -- On approval: balance was already deducted on request, no further deduction needed
  -- Just record the approval timestamp
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'approved') THEN
    NEW.processed_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;
