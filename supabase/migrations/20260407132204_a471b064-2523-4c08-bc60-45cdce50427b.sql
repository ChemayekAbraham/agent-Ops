
CREATE OR REPLACE FUNCTION public.credit_proxy_approval(
  p_agent_id UUID,
  p_beneficiary_id UUID,
  p_amount NUMERIC,
  p_source_id TEXT,
  p_transaction_group_id TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Insert ledger entry crediting the agent's wallet
  INSERT INTO public.general_ledger (
    user_id,
    entry_type,
    amount,
    category,
    description,
    source_table,
    source_id,
    linked_party,
    transaction_group_id,
    ledger_scope
  ) VALUES (
    p_agent_id,
    'cash_in',
    p_amount,
    'roi_payout',
    'Proxy partner investment credit on approval',
    'investor_portfolios',
    p_source_id,
    p_beneficiary_id::text,
    p_transaction_group_id,
    'wallet'
  );
  -- sync_wallet_from_ledger trigger handles balance update automatically
END;
$$;
