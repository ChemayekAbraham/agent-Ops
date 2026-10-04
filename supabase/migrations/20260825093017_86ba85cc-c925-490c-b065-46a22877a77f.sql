ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS access_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS access_daily_amount numeric;

ALTER TABLE public.merchandise_recovery_plans
  ADD COLUMN IF NOT EXISTS daily_deduction_amount numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.agent_accept_device_access(
  p_sale_id uuid,
  p_daily_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_daily numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_sale.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'You can only accept your own device order';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'approved' THEN
    RAISE EXCEPTION 'Order is not approved for access';
  END IF;
  IF v_sale.access_accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Device access was already accepted';
  END IF;

  v_daily := round(COALESCE(p_daily_amount, 0));
  IF v_daily < 1000 THEN
    RAISE EXCEPTION 'Daily amount must be at least UGX 1,000';
  END IF;

  UPDATE public.merchandise_sales
  SET access_accepted_at = now(),
      access_daily_amount = v_daily
  WHERE id = p_sale_id;

  UPDATE public.merchandise_recovery_plans
  SET daily_deduction_amount = v_daily,
      updated_at = now()
  WHERE sale_id = p_sale_id AND status = 'active';

  INSERT INTO public.system_events (event_type, user_id, description, metadata)
  VALUES (
    'account_activated',
    v_uid,
    'Agent accepted device access with daily wallet deduction',
    jsonb_build_object('sale_id', p_sale_id, 'daily_amount', v_daily, 'item_name', v_sale.item_name)
  );

  RETURN jsonb_build_object('sale_id', p_sale_id, 'daily_amount', v_daily, 'accepted_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.agent_accept_device_access(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_accept_device_access(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_accept_device_access(uuid, numeric) TO service_role;