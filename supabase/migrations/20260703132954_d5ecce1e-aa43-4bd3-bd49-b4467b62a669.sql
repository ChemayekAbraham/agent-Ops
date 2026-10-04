CREATE OR REPLACE FUNCTION public.get_merchant_float_network_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_merchant boolean;
  v_total_demand numeric := 0;
  v_network_float numeric := 0;
  v_pending_requested numeric := 0;
  v_active_merchants integer := 0;
  v_cutoff timestamptz := now() - interval '15 minutes';
BEGIN
  -- Only active merchant (cash-out) agents may read the shared network view.
  SELECT EXISTS (
    SELECT 1 FROM public.cashout_agents
    WHERE agent_id = auth.uid() AND is_active = true
  ) INTO v_is_merchant;

  IF NOT v_is_merchant THEN
    RETURN jsonb_build_object(
      'is_merchant', false,
      'total_demand', 0,
      'network_float', 0,
      'pending_requested', 0,
      'active_merchants', 0,
      'net_gap', 0,
      'fair_share', 0
    );
  END IF;

  -- Total money still needed to clear every payout waiting for a merchant:
  -- unclaimed OR a claim that has expired (>15 min).
  SELECT COALESCE(SUM(amount), 0)
  INTO v_total_demand
  FROM public.withdrawal_requests
  WHERE status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')
    AND (assigned_cashout_agent_id IS NULL OR dispatched_at < v_cutoff);

  -- Active merchant agents.
  SELECT COUNT(*) INTO v_active_merchants
  FROM public.cashout_agents WHERE is_active = true;

  -- Float already held across the whole merchant network.
  SELECT COALESCE(SUM(s.float_balance), 0)
  INTO v_network_float
  FROM public.v_user_wallet_strict s
  WHERE s.user_id IN (SELECT agent_id FROM public.cashout_agents WHERE is_active = true);

  -- Float already requested from the CFO but not yet funded (avoid re-requesting).
  SELECT COALESCE(SUM(requested_amount), 0)
  INTO v_pending_requested
  FROM public.float_requests
  WHERE status = 'pending'
    AND agent_id IN (SELECT agent_id FROM public.cashout_agents WHERE is_active = true);

  RETURN jsonb_build_object(
    'is_merchant', true,
    'total_demand', v_total_demand,
    'network_float', v_network_float,
    'pending_requested', v_pending_requested,
    'active_merchants', v_active_merchants,
    'net_gap', GREATEST(0, v_total_demand - v_network_float - v_pending_requested),
    'fair_share', CASE
      WHEN v_active_merchants > 0
        THEN CEIL(GREATEST(0, v_total_demand - v_network_float - v_pending_requested) / v_active_merchants)
      ELSE GREATEST(0, v_total_demand - v_network_float - v_pending_requested)
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_merchant_float_network_status() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_merchant_float_network_status() FROM anon;