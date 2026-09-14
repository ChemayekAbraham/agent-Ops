CREATE OR REPLACE FUNCTION public.tenant_rent_plan_detail()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_plan RECORD;
  v_house_name text;
  v_agent_name text;
  v_score numeric := 0;
  v_due_now numeric := 0;
  v_wallet numeric := 0;
  v_payments jsonb := '[]'::jsonb;
  v_start date;
  v_end date;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('plan', NULL);
  END IF;

  SELECT rr.id, rr.status,
         COALESCE(rr.total_repayment, 0) AS total_repayment,
         COALESCE(rr.amount_repaid, 0) AS amount_repaid,
         COALESCE(rr.daily_repayment, 0) AS daily_repayment,
         COALESCE(rr.duration_days, 30) AS duration_days,
         COALESCE(rr.disbursed_at, rr.created_at)::date AS start_date,
         COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
         rr.house_category, rr.request_city,
         COALESCE(rr.initial_outstanding_balance, 0) AS initial_outstanding_balance
    INTO v_plan
    FROM public.rent_requests rr
   WHERE rr.tenant_id = v_uid
     AND rr.status IN ('funded', 'disbursed', 'repaying')
     AND COALESCE(rr.tenancy_status, 'active') <> 'ended'
     AND COALESCE(rr.amount_repaid, 0) < COALESCE(rr.total_repayment, 0)
   ORDER BY rr.created_at ASC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('plan', NULL);
  END IF;

  v_start := v_plan.start_date;
  v_end := v_plan.start_date + (GREATEST(1, v_plan.duration_days) || ' days')::interval;

  SELECT NULLIF(trim(concat_ws(', ', NULLIF(hl.title, ''), NULLIF(COALESCE(hl.district, hl.region), ''))), '')
    INTO v_house_name
    FROM public.house_listings hl
   WHERE hl.tenant_id = v_uid
   ORDER BY hl.created_at DESC NULLS LAST
   LIMIT 1;

  IF v_house_name IS NULL THEN
    v_house_name := NULLIF(trim(concat_ws(', ', NULLIF(v_plan.house_category, ''), NULLIF(v_plan.request_city, ''))), '');
  END IF;

  IF v_plan.agent_id IS NOT NULL THEN
    SELECT p.full_name INTO v_agent_name FROM public.profiles p WHERE p.id = v_plan.agent_id;
  END IF;

  SELECT COALESCE(c.score, 0) INTO v_score
    FROM public.welile_trust_score_cache c
   WHERE c.user_id = v_uid;
  v_score := COALESCE(v_score, 0);

  BEGIN
    v_due_now := COALESCE(public.rent_plan_amount_due_now(v_plan.id), 0);
  EXCEPTION WHEN OTHERS THEN
    v_due_now := LEAST(GREATEST(v_plan.total_repayment - v_plan.amount_repaid, 0), v_plan.daily_repayment);
  END;

  BEGIN
    v_wallet := COALESCE(public.get_user_available_balance(v_uid), 0);
  EXCEPTION WHEN OTHERS THEN
    v_wallet := 0;
  END;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'date' DESC), '[]'::jsonb) INTO v_payments
    FROM (
      SELECT jsonb_build_object(
               'date', r.created_at,
               'amount', COALESCE(r.amount, 0),
               'method', CASE
                 WHEN r.payment_method IS NULL THEN 'Payment'
                 WHEN r.payment_method ILIKE '%agent%' THEN 'Agent collection'
                 WHEN r.payment_method ILIKE '%momo%' OR r.payment_method ILIKE '%mobile%' THEN 'Mobile Money'
                 WHEN r.payment_method ILIKE '%wallet%' THEN 'Wallet'
                 WHEN r.payment_method ILIKE '%cash%' THEN 'Cash'
                 ELSE initcap(replace(r.payment_method, '_', ' '))
               END
             ) AS x
        FROM public.repayments r
       WHERE r.rent_request_id = v_plan.id
         AND r.tenant_id = v_uid
       ORDER BY r.created_at DESC
       LIMIT 10
    ) s;

  RETURN jsonb_build_object(
    'plan', jsonb_build_object(
      'id', v_plan.id,
      'status', v_plan.status,
      'total_amount', v_plan.total_repayment,
      'amount_repaid', v_plan.amount_repaid,
      'outstanding', GREATEST(v_plan.total_repayment - v_plan.amount_repaid, 0),
      'daily_amount', v_plan.daily_repayment,
      'term_days', GREATEST(1, v_plan.duration_days),
      'term_start', v_start,
      'term_end', v_end,
      'obligation_end', v_end,
      'days_elapsed', GREATEST(0, (CURRENT_DATE - v_start)),
      'behaviour_score', round(v_score),
      'house_name', COALESCE(v_house_name, 'Your home'),
      'agent_name', COALESCE(v_agent_name, 'Your agent'),
      'due_now', v_due_now
    ),
    'wallet_balance', v_wallet,
    'recent_payments', v_payments
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.tenant_rent_plan_detail() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_rent_plan_detail() TO authenticated;