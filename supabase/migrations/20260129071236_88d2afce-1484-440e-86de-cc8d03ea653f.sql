-- Ensure agent commission payouts always debit the agent wallet when approved

CREATE OR REPLACE FUNCTION public.process_agent_commission_payout_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated_wallet_id uuid;
BEGIN
  -- Only act on transition to approved
  IF TG_OP = 'UPDATE' AND NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    -- Atomic debit: only succeeds if wallet exists AND has sufficient funds
    UPDATE public.wallets
    SET balance = balance - NEW.amount,
        updated_at = now()
    WHERE user_id = NEW.agent_id
      AND balance >= NEW.amount
    RETURNING id INTO v_updated_wallet_id;

    IF v_updated_wallet_id IS NULL THEN
      RAISE EXCEPTION 'Cannot approve payout: wallet missing or insufficient balance';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_process_agent_commission_payout_approval ON public.agent_commission_payouts;

CREATE TRIGGER trg_process_agent_commission_payout_approval
AFTER UPDATE OF status ON public.agent_commission_payouts
FOR EACH ROW
EXECUTE FUNCTION public.process_agent_commission_payout_approval();
