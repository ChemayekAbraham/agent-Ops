CREATE OR REPLACE FUNCTION public.preview_welile_home_enrollment_edit(
  p_subscription_id uuid,
  p_agent_id uuid,
  p_monthly_rent numeric,
  p_payout_day integer,
  p_has_smartphone boolean
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
  v_old_rent numeric;
  v_old_payout_day int;
  v_old_smartphone boolean;
  v_old_receivable numeric;
  v_old_outstanding numeric;
  v_old_next_due date;
  v_payout_day int;
  v_fee numeric;
  v_agent_comm numeric;
  v_landlord_net numeric;
  v_adjusted int;
  v_collected numeric;
  v_new_receivable numeric;
  v_new_next_due date;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  IF p_monthly_rent IS NULL OR p_monthly_rent <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Monthly rent must be greater than zero');
  END IF;

  SELECT agent_id, monthly_rent, payout_day, has_smartphone, receivable_total, outstanding_balance, next_due_date
  INTO v_owner, v_old_rent, v_old_payout_day, v_old_smartphone, v_old_receivable, v_old_outstanding, v_old_next_due
  FROM public.welile_homes_subscriptions
  WHERE id = p_subscription_id AND mode = 'agent_collection';

  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Welile Homes enrollment not found');
  END IF;

  IF v_owner <> p_agent_id AND NOT public.is_ops_role(p_agent_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized to preview this enrollment');
  END IF;

  v_payout_day   := LEAST(GREATEST(COALESCE(p_payout_day, 5), 1), 28);
  v_fee          := round(p_monthly_rent * 0.10, 2);
  v_agent_comm   := round(p_monthly_rent * 0.02, 2);
  v_landlord_net := p_monthly_rent - v_fee;

  -- Field-level change list (only fields that actually change).
  IF COALESCE(v_old_rent, -1) <> p_monthly_rent THEN
    v_changes := v_changes || jsonb_build_object('field','monthly_rent','old',v_old_rent,'new',p_monthly_rent);
  END IF;
  IF COALESCE(v_old_payout_day, -1) <> v_payout_day THEN
    v_changes := v_changes || jsonb_build_object('field','payout_day','old',v_old_payout_day,'new',v_payout_day);
  END IF;
  IF COALESCE(v_old_smartphone, NOT p_has_smartphone) <> p_has_smartphone THEN
    v_changes := v_changes || jsonb_build_object('field','has_smartphone','old',v_old_smartphone,'new',p_has_smartphone);
  END IF;

  -- How many upcoming months would be re-priced.
  SELECT count(*)
  INTO v_adjusted
  FROM public.welile_homes_monthly_dues
  WHERE subscription_id = p_subscription_id
    AND amount_collected = 0
    AND collection_status = 'pending';

  -- Simulated receivable: pending/uncollected months take the new rent, everything else keeps its due.
  SELECT
    COALESCE(sum(CASE WHEN amount_collected = 0 AND collection_status = 'pending'
                      THEN p_monthly_rent ELSE amount_due END), 0),
    COALESCE(sum(amount_collected), 0)
  INTO v_new_receivable, v_collected
  FROM public.welile_homes_monthly_dues
  WHERE subscription_id = p_subscription_id;

  -- Simulated next due date after shifting unpaid payout days.
  SELECT min(CASE WHEN payout_status = 'unpaid'
                  THEN (period_month + (v_payout_day - 1))
                  ELSE payout_date END)
  INTO v_new_next_due
  FROM public.welile_homes_monthly_dues
  WHERE subscription_id = p_subscription_id
    AND collection_status <> 'collected';

  RETURN jsonb_build_object(
    'success', true,
    'changes', v_changes,
    'months_adjusted', v_adjusted,
    'monthly_rent', jsonb_build_object('old', v_old_rent, 'new', p_monthly_rent),
    'payout_day', jsonb_build_object('old', v_old_payout_day, 'new', v_payout_day),
    'has_smartphone', jsonb_build_object('old', v_old_smartphone, 'new', p_has_smartphone),
    'agent_commission_per_month', jsonb_build_object('old', round(COALESCE(v_old_rent,0) * 0.02, 2), 'new', v_agent_comm),
    'landlord_net_per_month', jsonb_build_object('old', round(COALESCE(v_old_rent,0) * 0.90, 2), 'new', v_landlord_net),
    'receivable_total', jsonb_build_object('old', COALESCE(v_old_receivable,0), 'new', v_new_receivable),
    'outstanding_balance', jsonb_build_object('old', COALESCE(v_old_outstanding,0), 'new', GREATEST(0, v_new_receivable - v_collected)),
    'next_due_date', jsonb_build_object('old', v_old_next_due, 'new', v_new_next_due)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.preview_welile_home_enrollment_edit(uuid, uuid, numeric, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_welile_home_enrollment_edit(uuid, uuid, numeric, integer, boolean) TO service_role;