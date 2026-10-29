-- 1. get_agent_partnership_summary counted only active portfolios, so an agent whose portfolio was
--    pending approval, awaiting partner details, locked or redeemed read as "No active portfolio".
--    The active figures are unchanged; pending / locked / redeemed counts are added alongside.
-- 2. agent_ops_set_smartphone_repayment_methods accepted "Partnership Returns" for an agent with no
--    active portfolio. With commission switched off as well, nothing would be collected for the
--    phone and the shortfall only showed up later. Turning Returns on now needs an active portfolio
--    (an existing Returns setting can still be edited or switched off).
CREATE OR REPLACE FUNCTION public.get_agent_partnership_summary(p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v jsonb;
BEGIN
  IF NOT (
    coalesce(auth.role(), 'service_role') = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_uid AND ur.enabled = true
        AND ur.role IN ('agent_ops','operations','manager','coo','cfo','ceo','super_admin','partner_ops','financial_ops'))
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'count',    count(*) FILTER (WHERE status = 'active'),
    'amount',   COALESCE(sum(investment_amount) FILTER (WHERE status = 'active'), 0),
    'earned',   COALESCE(sum(total_roi_earned) FILTER (WHERE status = 'active'), 0),
    'monthly',  COALESCE(sum(investment_amount * COALESCE(roi_percentage, 0) / 100) FILTER (WHERE status = 'active'), 0),
    'pending',  count(*) FILTER (WHERE status IN ('pending_ops_approval', 'awaiting_partner_details')),
    'locked',   count(*) FILTER (WHERE status = 'locked'),
    'redeemed', count(*) FILTER (WHERE status = 'redeemed')
  ) INTO v
  FROM public.investor_portfolios
  WHERE investor_id = p_agent_id;
  RETURN v;
END
$function$;

CREATE OR REPLACE FUNCTION public.agent_ops_set_smartphone_repayment_methods(p_agent_id uuid, p_use_commission boolean, p_use_returns boolean, p_returns_mode text DEFAULT NULL::text, p_returns_value numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_before jsonb;
  v_plans int;
  v_mode text := lower(btrim(COALESCE(p_returns_mode, '')));
  v_value numeric;
BEGIN
  IF NOT public._agent_ops_can_set_repayment_methods(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to change repayment methods' USING ERRCODE = '42501';
  END IF;
  IF p_agent_id IS NULL OR p_use_commission IS NULL OR p_use_returns IS NULL THEN
    RAISE EXCEPTION 'Agent and both repayment choices are required';
  END IF;
  IF p_use_returns THEN
    IF v_mode NOT IN ('amount', 'percent') THEN
      RAISE EXCEPTION 'Choose a fixed amount or a percentage of Returns';
    END IF;
    v_value := round(p_returns_value);
    IF v_value IS NULL OR v_value <= 0 OR (v_mode = 'percent' AND v_value > 100) THEN
      RAISE EXCEPTION 'Enter a Returns deduction above 0 (a percentage can be at most 100)';
    END IF;
  END IF;
  v_before := public.get_agent_smartphone_repayment_methods(p_agent_id);
  IF COALESCE((v_before->>'active_plans')::int, 0) = 0 THEN
    RAISE EXCEPTION 'This agent has no active smartphone repayment';
  END IF;
  IF p_use_returns
     AND NOT COALESCE((v_before->>'returns_enabled')::boolean, false)
     AND COALESCE((v_before->>'active_portfolios')::int, 0) = 0 THEN
    RAISE EXCEPTION 'This agent has no active partnership portfolio, so there are no Returns to deduct from';
  END IF;
  UPDATE public.merchandise_recovery_plans p
     SET phone_collection_enabled = p_use_commission, updated_at = now()
   WHERE p.customer_id = p_agent_id AND p.status = 'active' AND p.outstanding_balance > 0
     AND NOT COALESCE(p.is_bike_lease, false) AND p.item_name ILIKE '%smartphone%'
     AND p.phone_collection_enabled IS DISTINCT FROM p_use_commission;
  GET DIAGNOSTICS v_plans = ROW_COUNT;
  IF p_use_returns THEN
    INSERT INTO public.smartphone_roi_pledges (user_id, mode, value, active)
    VALUES (p_agent_id, v_mode, v_value, true)
    ON CONFLICT (user_id) DO UPDATE
      SET mode = EXCLUDED.mode, value = EXCLUDED.value, active = true, updated_at = now();
  ELSE
    UPDATE public.smartphone_roi_pledges SET active = false, updated_at = now()
     WHERE user_id = p_agent_id AND active;
  END IF;
  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, old_values, new_values, metadata)
  VALUES (v_uid, 'agent_ops_smartphone_repayment_methods', 'update', 'merchandise_recovery_plans', p_agent_id::text,
    NULLIF(btrim(COALESCE(p_reason, '')), ''), v_before,
    jsonb_build_object('commission_enabled', p_use_commission, 'returns_enabled', p_use_returns,
                       'returns_mode', CASE WHEN p_use_returns THEN v_mode END,
                       'returns_value', CASE WHEN p_use_returns THEN v_value END),
    jsonb_build_object('agent_id', p_agent_id, 'plans_changed', v_plans));
  RETURN public.get_agent_smartphone_repayment_methods(p_agent_id);
END
$function$;
