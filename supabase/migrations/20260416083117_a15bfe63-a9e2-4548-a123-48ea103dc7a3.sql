
-- Fix: deduct_wallet_on_withdrawal_request trigger
CREATE OR REPLACE FUNCTION public.deduct_wallet_on_withdrawal_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act on new pending requests
  IF NEW.status = 'pending' THEN
    -- Authorize the wallet update to bypass guard_wallet_direct_update
    PERFORM set_config('wallet.sync_authorized', 'true', true);

    UPDATE wallets
    SET balance = balance - NEW.amount,
        updated_at = now()
    WHERE user_id = NEW.user_id
      AND balance >= NEW.amount;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient wallet balance for withdrawal of %', NEW.amount;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Fix: handle_withdrawal_approval trigger
CREATE OR REPLACE FUNCTION public.handle_withdrawal_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act on status changes
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    -- Authorize the wallet update to bypass guard_wallet_direct_update
    PERFORM set_config('wallet.sync_authorized', 'true', true);

    -- If rejected: refund the held amount back to wallet
    IF NEW.status = 'rejected' AND OLD.status IN ('pending', 'under_review', 'ops_approved') THEN
      UPDATE wallets
      SET balance = balance + NEW.amount,
          updated_at = now()
      WHERE user_id = NEW.user_id;
    END IF;

    -- If completed/approved: money already deducted at request time, no further action needed
    -- (The deduction happened in deduct_wallet_on_withdrawal_request)
  END IF;

  RETURN NEW;
END;
$$;
