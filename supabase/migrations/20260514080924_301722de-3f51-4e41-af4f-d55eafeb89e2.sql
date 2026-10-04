
CREATE OR REPLACE FUNCTION public.get_proxy_partner_balance(p_agent_id uuid, p_partner_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_partner_withdrawable NUMERIC := 0;
  v_legacy_credited      NUMERIC := 0;
  v_legacy_withdrawn     NUMERIC := 0;
  v_legacy_remaining     NUMERIC := 0;
BEGIN
  -- Post-cutoff (Proxy Custody v2): partner ROI now lands directly in the partner's
  -- own wallet. The proxy agent can initiate a withdraw up to the partner's strict
  -- withdrawable balance (already net of pending holds).
  SELECT COALESCE(public.get_user_available_balance(p_partner_id), 0)
    INTO v_partner_withdrawable;

  -- Pre-cutoff (legacy): some credits were parked on the AGENT's wallet tagged
  -- "on behalf of partner <uuid>". Drain via existing approve-withdrawal branch.
  SELECT COALESCE(SUM(amount), 0) INTO v_legacy_credited
  FROM general_ledger
  WHERE user_id = p_agent_id
    AND direction = 'cash_in'
    AND category = 'roi_wallet_credit'
    AND description ILIKE '%on behalf of partner ' || p_partner_id::text || '%';

  SELECT COALESCE(SUM(amount), 0) INTO v_legacy_withdrawn
  FROM withdrawal_requests
  WHERE user_id = p_agent_id
    AND proxy_partner_id = p_partner_id
    AND status IN ('pending', 'under_review', 'ops_approved', 'completed', 'approved');

  v_legacy_remaining := GREATEST(v_legacy_credited - v_legacy_withdrawn, 0);

  RETURN v_partner_withdrawable + v_legacy_remaining;
END;
$function$;
