
CREATE OR REPLACE FUNCTION public.credit_proxy_approval(
  p_agent_id UUID,
  p_beneficiary_id UUID,
  p_amount NUMERIC,
  p_description TEXT,
  p_transaction_group_id TEXT,
  p_source_id UUID,
  p_portfolio_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx_uuid UUID;
BEGIN
  -- Generate deterministic UUID from text key using md5
  v_tx_uuid := md5(p_transaction_group_id)::uuid;

  -- Idempotency check
  IF EXISTS (
    SELECT 1 FROM general_ledger
    WHERE transaction_group_id = v_tx_uuid
    LIMIT 1
  ) THEN
    RETURN FALSE;
  END IF;

  INSERT INTO general_ledger (
    user_id, amount, direction, category, description,
    currency, transaction_group_id, source_table, source_id,
    ledger_scope, linked_party
  ) VALUES (
    p_agent_id, p_amount, 'cash_in', 'roi_payout', p_description,
    'UGX', v_tx_uuid, 'investor_portfolios', p_source_id,
    'wallet', p_beneficiary_id
  );

  RETURN TRUE;
END;
$$;
