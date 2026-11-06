-- Agent Ops: choose how an agent repays an issued Welile Smartphone.
--
-- Two sources already exist in production; this only gives Agent Ops a switch for each:
--   * Commission (agent wallet): merchandise_recovery_plans.phone_collection_enabled turns on
--     the daily recover_smartphone_from_wallets sweep for the plan (daily instalment taken
--     from the agent's withdrawable wallet, where commission lands).
--   * Partnership Returns: smartphone_roi_pledges (amount per payment or % of each payment),
--     applied by apply_smartphone_roi_pledge when Returns are paid. Until now only the agent
--     could set it (set_smartphone_roi_pledge); Agent Ops can now set it on their behalf.
-- No ledger posting happens here. Every deduction still runs through the existing functions.

CREATE OR REPLACE FUNCTION public._agent_ops_can_set_repayment_methods(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select _uid is not null and exists (
    select 1 from public.user_roles ur
    where ur.user_id = _uid and ur.enabled = true
      and ur.role in ('agent_ops','operations','manager','coo','cfo','ceo','super_admin'));
$function$;

REVOKE ALL ON FUNCTION public._agent_ops_can_set_repayment_methods(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_ops_can_set_repayment_methods(uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.get_agent_smartphone_repayment_methods(p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plans int; v_on int; v_pledge record; v_portfolios int;
BEGIN
  IF NOT public.can_view_staff_reports(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE p.phone_collection_enabled)
    INTO v_plans, v_on
  FROM public.merchandise_recovery_plans p
  WHERE p.customer_id = p_agent_id AND p.status = 'active' AND p.outstanding_balance > 0
    AND NOT COALESCE(p.is_bike_lease, false) AND p.item_name ILIKE '%smartphone%';

  SELECT mode, value, active, updated_at INTO v_pledge
  FROM public.smartphone_roi_pledges WHERE user_id = p_agent_id;

  SELECT count(*) INTO v_portfolios
  FROM public.investor_portfolios WHERE investor_id = p_agent_id AND status = 'active';

  RETURN jsonb_build_object(
    'active_plans', v_plans,
    'commission_enabled_plans', v_on,
    'commission_enabled', v_plans > 0 AND v_on = v_plans,
    'returns_enabled', COALESCE(v_pledge.active, false),
    'returns_mode', v_pledge.mode,
    'returns_value', v_pledge.value,
    'returns_updated_at', v_pledge.updated_at,
    'active_portfolios', v_portfolios,
    'can_edit', public._agent_ops_can_set_repayment_methods(auth.uid())
  );
END
$function$;

REVOKE ALL ON FUNCTION public.get_agent_smartphone_repayment_methods(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_smartphone_repayment_methods(uuid) TO authenticated, service_role;


-- First repayment day per agent (earliest active phone plan). starts_on is set when the CFO
-- disburses the phone (disbursement + 7-day grace), so it is the real start, not issue date + 7.
CREATE OR REPLACE FUNCTION public.get_smartphone_repayment_start_dates()
RETURNS TABLE (agent_id uuid, starts_on date)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.can_view_staff_reports(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT p.customer_id, min(p.starts_on)
  FROM public.merchandise_recovery_plans p
  WHERE p.status = 'active' AND p.outstanding_balance > 0 AND p.starts_on IS NOT NULL
    AND NOT COALESCE(p.is_bike_lease, false) AND p.item_name ILIKE '%smartphone%'
  GROUP BY p.customer_id;
END
$function$;

REVOKE ALL ON FUNCTION public.get_smartphone_repayment_start_dates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_smartphone_repayment_start_dates() TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.agent_ops_set_smartphone_repayment_methods(
  p_agent_id uuid,
  p_use_commission boolean,
  p_use_returns boolean,
  p_returns_mode text DEFAULT NULL,
  p_returns_value numeric DEFAULT NULL,
  p_reason text DEFAULT NULL
)
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
    UPDATE public.smartphone_roi_pledges
       SET active = false, updated_at = now()
     WHERE user_id = p_agent_id AND active;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, old_values, new_values, metadata)
  VALUES (v_uid, 'agent_ops_smartphone_repayment_methods', 'update', 'merchandise_recovery_plans', p_agent_id::text,
    NULLIF(btrim(COALESCE(p_reason, '')), ''),
    v_before,
    jsonb_build_object('commission_enabled', p_use_commission, 'returns_enabled', p_use_returns,
                       'returns_mode', CASE WHEN p_use_returns THEN v_mode END,
                       'returns_value', CASE WHEN p_use_returns THEN v_value END),
    jsonb_build_object('agent_id', p_agent_id, 'plans_changed', v_plans));

  RETURN public.get_agent_smartphone_repayment_methods(p_agent_id);
END
$function$;

REVOKE ALL ON FUNCTION public.agent_ops_set_smartphone_repayment_methods(uuid, boolean, boolean, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_set_smartphone_repayment_methods(uuid, boolean, boolean, text, numeric, text) TO authenticated, service_role;
