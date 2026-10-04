
-- Remove refund-on-rejection for withdrawal requests
-- Rejected withdrawals should NOT bounce money back to the wallet

CREATE OR REPLACE FUNCTION public.handle_withdrawal_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- On rejection: do NOT refund. Money stays deducted.
  -- On approval: no additional deduction (already deducted on request creation).
  RETURN NEW;
END;
$$;

-- Remove refund-on-rejection for agent commission payouts
CREATE OR REPLACE FUNCTION public.handle_agent_payout_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- On rejection: do NOT refund. Money stays deducted.
  -- On approval: no additional deduction (already deducted on request creation).
  RETURN NEW;
END;
$$;
