
CREATE OR REPLACE FUNCTION public.get_proxy_partner_balance(p_agent_id uuid, p_partner_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_partner_withdrawable NUMERIC := 0;
  v_roi_credited         NUMERIC := 0;
  v_proxy_withdrawn      NUMERIC := 0;
  v_legacy_credited      NUMERIC := 0;
  v_legacy_withdrawn     NUMERIC := 0;
  v_legacy_remaining     NUMERIC := 0;
  v_roi_available        NUMERIC := 0;
BEGIN
  -- Strict withdrawable on partner's own wallet (already net of pending holds).
  SELECT COALESCE(public.get_user_available_balance(p_partner_id), 0)
    INTO v_partner_withdrawable;

  -- ROI / Returns credited to the PARTNER's wallet (post Proxy Custody v2).
  SELECT COALESCE(SUM(amount), 0) INTO v_roi_credited
  FROM general_ledger
  WHERE user_id = p_partner_id
    AND direction = 'cash_in'
    AND category IN ('roi_wallet_credit', 'roi_payout');

  -- Proxy withdrawals already raised by THIS agent for THIS partner (post-v2 model:
  -- partner is the wallet owner, agent is initiator).
  SELECT COALESCE(SUM(amount), 0) INTO v_proxy_withdrawn
  FROM withdrawal_requests
  WHERE user_id = p_partner_id
    AND agent_id = p_agent_id
    AND status IN ('pending', 'under_review', 'ops_approved', 'completed', 'approved');

  -- Legacy (pre-cutoff) ROI parked on the AGENT's wallet tagged for this partner.
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

  -- Returns the agent can withdraw on behalf of the partner = ROI net of proxy
  -- withdrawals + legacy parked. Cap at the partner's actual withdrawable so we
  -- never over-promise vs the strict ledger.
  v_roi_available := GREATEST(v_roi_credited - v_proxy_withdrawn, 0) + v_legacy_remaining;

  RETURN LEAST(v_roi_available, v_partner_withdrawable + v_legacy_remaining);
END;
$function$;
