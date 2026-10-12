CREATE OR REPLACE FUNCTION public.get_service_center_active_advances()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  WITH team AS (
    SELECT v_me AS uid, true AS is_self
    UNION
    SELECT s.sub_agent_id, false FROM public.agent_subagents s
    WHERE s.parent_agent_id = v_me AND s.status = 'verified'
  ),
  plans AS (
    SELECT p.*, t.is_self, pr.full_name AS holder_name, pr.phone AS holder_phone
    FROM public.merchandise_recovery_plans p
    JOIN team t ON t.uid = p.customer_id
    LEFT JOIN public.profiles pr ON pr.id = p.customer_id
    WHERE p.status = 'active'
  ),
  pays AS (
    SELECT d.plan_id,
           SUM(d.amount) FILTER (WHERE d.created_at >= now() - interval '7 days') AS paid_7d,
           jsonb_agg(jsonb_build_object('amount', d.amount, 'at', d.created_at, 'outstanding_after', d.outstanding_after)
                     ORDER BY d.created_at DESC) FILTER (WHERE d.rn <= 10) AS recent
    FROM (SELECT d.*, row_number() OVER (PARTITION BY d.plan_id ORDER BY d.created_at DESC) rn
          FROM public.merchandise_recovery_deductions d
          WHERE d.plan_id IN (SELECT id FROM plans)) d
    GROUP BY d.plan_id
  )
  SELECT jsonb_build_object(
    'centre_name', (SELECT location_name FROM public.service_centre_setups WHERE agent_id = v_me ORDER BY created_at DESC LIMIT 1),
    'manager_name', (SELECT full_name FROM public.profiles WHERE id = v_me),
    'plans', COALESCE(jsonb_agg(jsonb_build_object(
      'id', p.id, 'item_name', p.item_name, 'category', public.agent_product_category(p.item_name),
      'holder_id', p.customer_id, 'holder_name', COALESCE(p.holder_name, p.customer_name),
      'holder_phone', COALESCE(p.holder_phone, p.customer_phone), 'is_self', p.is_self,
      'original_amount', COALESCE(p.original_amount,0), 'repaid', COALESCE(p.amount_recovered,0),
      'outstanding', COALESCE(p.outstanding_balance,0),
      'daily', COALESCE(p.daily_amount_fixed, p.daily_deduction_amount, p.daily_rate, 0),
      'due_balance', COALESCE(p.due_balance,0), 'surcharge', COALESCE(p.overdue_surcharge_total,0),
      'starts_on', COALESCE(p.recovery_started_on, p.starts_on, p.created_at::date), 'term_end_on', p.term_end_on,
      'last_paid_at', p.last_recovery_at, 'on_hold', COALESCE(p.recovery_hold,false),
      'paid_7d', COALESCE(pa.paid_7d,0), 'recent', COALESCE(pa.recent,'[]'::jsonb)
    ) ORDER BY p.outstanding_balance DESC), '[]'::jsonb)
  ) INTO v_result
  FROM plans p LEFT JOIN pays pa ON pa.plan_id = p.id;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.get_service_center_active_advances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_service_center_active_advances() TO authenticated;