CREATE OR REPLACE FUNCTION public.edit_welile_home_enrollment(
  p_subscription_id uuid,
  p_agent_id uuid,
  p_monthly_rent numeric,
  p_payout_day integer,
  p_has_smartphone boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
  v_tenant_id uuid;
  v_payout_day int;
  v_fee numeric;
  v_agent_comm numeric;
  v_welile_net numeric;
  v_landlord_net numeric;
  v_receivable numeric;
  v_collected numeric;
  v_adjusted int;
BEGIN
  IF p_monthly_rent IS NULL OR p_monthly_rent <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Monthly rent must be greater than zero');
  END IF;

  SELECT agent_id, tenant_id INTO v_owner, v_tenant_id
  FROM public.welile_homes_subscriptions
  WHERE id = p_subscription_id AND mode = 'agent_collection';

  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Welile Homes enrollment not found');
  END IF;

  -- Only the managing agent or an ops role may edit.
  IF v_owner <> p_agent_id AND NOT public.is_ops_role(p_agent_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized to edit this enrollment');
  END IF;

  v_payout_day   := LEAST(GREATEST(COALESCE(p_payout_day, 5), 1), 28);
  v_fee          := round(p_monthly_rent * 0.10, 2);
  v_agent_comm   := round(p_monthly_rent * 0.02, 2);
  v_welile_net   := v_fee - v_agent_comm;
  v_landlord_net := p_monthly_rent - v_fee;

  -- Recompute amounts ONLY for months nothing has been collected on yet.
  UPDATE public.welile_homes_monthly_dues
  SET amount_due       = p_monthly_rent,
      landlord_fee     = v_fee,
      agent_commission = v_agent_comm,
      welile_net       = v_welile_net,
      landlord_net     = v_landlord_net,
      updated_at       = now()
  WHERE subscription_id = p_subscription_id
    AND amount_collected = 0
    AND collection_status = 'pending';
  GET DIAGNOSTICS v_adjusted = ROW_COUNT;

  -- Shift payout dates for every month that hasn't been paid out yet.
  UPDATE public.welile_homes_monthly_dues
  SET payout_date = (period_month + (v_payout_day - 1)),
      updated_at  = now()
  WHERE subscription_id = p_subscription_id
    AND payout_status = 'unpaid';

  -- Recompute rollups from the (now adjusted) schedule.
  SELECT COALESCE(sum(amount_due), 0), COALESCE(sum(amount_collected), 0)
  INTO v_receivable, v_collected
  FROM public.welile_homes_monthly_dues
  WHERE subscription_id = p_subscription_id;

  UPDATE public.welile_homes_subscriptions
  SET monthly_rent         = p_monthly_rent,
      payout_day           = v_payout_day,
      has_smartphone       = p_has_smartphone,
      monthly_landlord_fee = v_fee,
      receivable_total     = v_receivable,
      outstanding_balance  = GREATEST(0, v_receivable - v_collected),
      next_due_date        = (SELECT min(payout_date) FROM public.welile_homes_monthly_dues
                              WHERE subscription_id = p_subscription_id AND collection_status <> 'collected'),
      updated_at           = now()
  WHERE id = p_subscription_id;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES ('agent_collection', p_agent_id, 'welile_homes_subscription', p_subscription_id,
      jsonb_build_object('action','edit','tenant_id',v_tenant_id,'monthly_rent',p_monthly_rent,
                         'payout_day',v_payout_day,'has_smartphone',p_has_smartphone,
                         'months_adjusted',v_adjusted,'receivable_total',v_receivable));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'subscription_id', p_subscription_id,
    'monthly_rent', p_monthly_rent,
    'payout_day', v_payout_day,
    'has_smartphone', p_has_smartphone,
    'months_adjusted', v_adjusted,
    'receivable_total', v_receivable,
    'outstanding_balance', GREATEST(0, v_receivable - v_collected),
    'agent_commission_per_month', v_agent_comm,
    'landlord_net_per_month', v_landlord_net
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.edit_welile_home_enrollment(uuid, uuid, numeric, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_welile_home_enrollment(uuid, uuid, numeric, integer, boolean) TO service_role;