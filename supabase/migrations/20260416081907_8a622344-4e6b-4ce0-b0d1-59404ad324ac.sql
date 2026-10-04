
-- 1. Add proxy_partner_id column to track which partner a proxy withdrawal is for
ALTER TABLE public.withdrawal_requests
ADD COLUMN IF NOT EXISTS proxy_partner_id UUID;

-- 2. Create RPC to compute proxy partner's available balance from the agent's ledger
CREATE OR REPLACE FUNCTION public.get_proxy_partner_balance(
  p_agent_id UUID,
  p_partner_id UUID
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credited NUMERIC := 0;
  v_withdrawn NUMERIC := 0;
BEGIN
  -- Sum all ROI credits on the agent's wallet tagged for this partner
  SELECT COALESCE(SUM(amount), 0) INTO v_credited
  FROM general_ledger
  WHERE user_id = p_agent_id
    AND direction = 'cash_in'
    AND category = 'roi_wallet_credit'
    AND description ILIKE '%on behalf of partner ' || p_partner_id::text || '%';

  -- Sum all proxy withdrawals (pending or completed) for this partner by this agent
  SELECT COALESCE(SUM(amount), 0) INTO v_withdrawn
  FROM withdrawal_requests
  WHERE user_id = p_agent_id
    AND proxy_partner_id = p_partner_id
    AND status IN ('pending', 'under_review', 'ops_approved', 'completed', 'approved');

  RETURN GREATEST(v_credited - v_withdrawn, 0);
END;
$$;

-- 3. Re-enable immediate wallet deduction on withdrawal request
CREATE OR REPLACE FUNCTION public.deduct_wallet_on_withdrawal_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Deduct from the requesting user's wallet immediately
  UPDATE wallets
  SET balance = balance - NEW.amount,
      updated_at = now()
  WHERE user_id = NEW.user_id
    AND balance >= NEW.amount;

  -- If no row was updated, the wallet doesn't have enough balance
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient wallet balance for withdrawal of %', NEW.amount;
  END IF;

  RETURN NEW;
END;
$$;

-- Re-create the trigger
DROP TRIGGER IF EXISTS trg_deduct_wallet_on_withdrawal_request ON public.withdrawal_requests;
CREATE TRIGGER trg_deduct_wallet_on_withdrawal_request
  BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.deduct_wallet_on_withdrawal_request();

-- 4. Update the approval trigger to handle proxy rejection refunds
CREATE OR REPLACE FUNCTION public.handle_withdrawal_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act on status changes
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- On rejection of a proxy withdrawal: refund the agent's wallet
  IF NEW.status = 'rejected' AND NEW.proxy_partner_id IS NOT NULL THEN
    UPDATE wallets
    SET balance = balance + NEW.amount,
        updated_at = now()
    WHERE user_id = NEW.user_id;

    -- Log the refund in the ledger
    INSERT INTO general_ledger (
      user_id, amount, direction, category, description,
      currency, transaction_group_id, source_table, source_id, ledger_scope
    ) VALUES (
      NEW.user_id, NEW.amount, 'cash_in', 'withdrawal_refund',
      'Proxy withdrawal rejected – funds returned for partner ' || NEW.proxy_partner_id::text,
      'UGX', 'wallet-withdraw-refund-' || NEW.id,
      'withdrawal_requests', NEW.id, 'platform'
    );
  END IF;

  -- On rejection of a non-proxy withdrawal: also refund
  IF NEW.status = 'rejected' AND NEW.proxy_partner_id IS NULL THEN
    UPDATE wallets
    SET balance = balance + NEW.amount,
        updated_at = now()
    WHERE user_id = NEW.user_id;

    INSERT INTO general_ledger (
      user_id, amount, direction, category, description,
      currency, transaction_group_id, source_table, source_id, ledger_scope
    ) VALUES (
      NEW.user_id, NEW.amount, 'cash_in', 'withdrawal_refund',
      'Withdrawal rejected – funds returned to wallet',
      'UGX', 'wallet-withdraw-refund-' || NEW.id,
      'withdrawal_requests', NEW.id, 'platform'
    );
  END IF;

  RETURN NEW;
END;
$$;
