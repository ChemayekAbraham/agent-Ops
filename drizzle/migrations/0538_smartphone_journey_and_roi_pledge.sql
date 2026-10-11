CREATE OR REPLACE FUNCTION public.has_active_smartphone_plan(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.merchandise_sales s
    WHERE s.customer_id = p_user AND s.item_name ILIKE '%smartphone%'
      AND s.cfo_disbursed_at IS NOT NULL AND COALESCE(s.amount_outstanding,0) > 0
      AND s.settlement_completed_at IS NULL)
$$;
GRANT EXECUTE ON FUNCTION public.has_active_smartphone_plan(uuid) TO authenticated;

CREATE TABLE public.smartphone_roi_pledges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  mode text NOT NULL CHECK (mode IN ('amount','percent')),
  value numeric NOT NULL CHECK (value > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smartphone_roi_pledge_pct_ck CHECK (mode <> 'percent' OR value <= 100)
);
GRANT SELECT ON public.smartphone_roi_pledges TO authenticated;
GRANT ALL ON public.smartphone_roi_pledges TO service_role;
ALTER TABLE public.smartphone_roi_pledges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pledge read" ON public.smartphone_roi_pledges FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE TABLE public.smartphone_roi_pledge_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  reference text NOT NULL UNIQUE,
  roi_amount numeric NOT NULL,
  pledged_amount numeric NOT NULL,
  applied_amount numeric NOT NULL,
  outstanding_after numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.smartphone_roi_pledge_applications TO authenticated;
GRANT ALL ON public.smartphone_roi_pledge_applications TO service_role;
ALTER TABLE public.smartphone_roi_pledge_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pledge apps read" ON public.smartphone_roi_pledge_applications FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.set_smartphone_roi_pledge(p_mode text, p_value numeric, p_active boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.has_active_smartphone_plan(v_uid) THEN RAISE EXCEPTION 'No active phone repayment'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.investor_portfolios WHERE investor_id = v_uid AND status = 'active') THEN
    RAISE EXCEPTION 'An active supporter portfolio is required';
  END IF;
  IF p_mode NOT IN ('amount','percent') THEN RAISE EXCEPTION 'Invalid mode'; END IF;
  IF p_value IS NULL OR p_value <= 0 OR (p_mode = 'percent' AND p_value > 100) THEN RAISE EXCEPTION 'Invalid value'; END IF;
  INSERT INTO public.smartphone_roi_pledges(user_id, mode, value, active)
  VALUES (v_uid, p_mode, round(p_value), COALESCE(p_active,true))
  ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, value = EXCLUDED.value, active = EXCLUDED.active, updated_at = now();
  INSERT INTO public.system_events(event_type, user_id, metadata)
  VALUES ('wallet_transfer', v_uid, jsonb_build_object('kind','smartphone_roi_pledge_set','mode',p_mode,'value',p_value,'active',p_active));
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_smartphone_roi_pledge(text,numeric,boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_smartphone_roi_pledge(text,numeric,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.apply_smartphone_roi_pledge(p_user_id uuid, p_roi_amount numeric, p_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_p record; v_plan record; v_pledged numeric; v_avail numeric; v_amount numeric; v_closing numeric;
BEGIN
  IF COALESCE(p_roi_amount,0) <= 0 THEN RETURN jsonb_build_object('applied',0,'reason','no_roi'); END IF;
  IF EXISTS (SELECT 1 FROM public.smartphone_roi_pledge_applications WHERE reference = p_reference) THEN
    RETURN jsonb_build_object('applied',0,'reason','already_applied');
  END IF;
  SELECT * INTO v_p FROM public.smartphone_roi_pledges WHERE user_id = p_user_id AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',0,'reason','no_pledge'); END IF;
  SELECT p.* INTO v_plan FROM public.merchandise_recovery_plans p
    JOIN public.merchandise_sales s ON s.id = p.sale_id
    WHERE p.customer_id = p_user_id AND p.status = 'active' AND p.outstanding_balance > 0
      AND NOT COALESCE(p.is_bike_lease,false) AND s.item_name ILIKE '%smartphone%'
    ORDER BY p.created_at LIMIT 1 FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',0,'reason','no_plan'); END IF;
  v_pledged := CASE WHEN v_p.mode = 'percent' THEN floor(p_roi_amount * v_p.value / 100) ELSE v_p.value END;
  v_avail := COALESCE(public.get_user_available_balance(p_user_id),0);
  v_amount := floor(LEAST(v_pledged, p_roi_amount, v_plan.outstanding_balance, v_avail));
  IF v_amount <= 0 THEN RETURN jsonb_build_object('applied',0,'reason','nothing_available'); END IF;

  PERFORM public.create_ledger_transaction(entries => jsonb_build_array(
    jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
      'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone repayment - ' || COALESCE(v_plan.item_name,'Welile Smartphone') || ' (from monthly Returns)'),
    jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
      'amount', v_amount, 'category', 'agent_advance_repayment', 'recipient_type', 'operational_wallet',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone advance recovered from monthly Returns: ' || COALESCE(v_plan.item_name,'Welile Smartphone'))
  ), idempotency_key => 'phone_roi_pledge_' || p_reference);

  v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);
  INSERT INTO public.merchandise_recovery_deductions (plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref)
    VALUES (v_plan.id, p_user_id, COALESCE(v_plan.item_name,'Welile Smartphone') || ' (from monthly Returns)', v_amount, v_avail, v_closing, gen_random_uuid());
  UPDATE public.merchandise_recovery_plans
    SET outstanding_balance = v_closing, amount_recovered = amount_recovered + v_amount,
        due_balance = GREATEST(0, COALESCE(due_balance,0) - v_amount), last_recovery_at = now(),
        status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
        completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END, updated_at = now()
    WHERE id = v_plan.id;
  UPDATE public.merchandise_sales
    SET amount_paid = COALESCE(amount_paid,0) + v_amount,
        amount_outstanding = GREATEST(0, COALESCE(amount_outstanding,0) - v_amount), updated_at = now()
    WHERE id = v_plan.sale_id;
  INSERT INTO public.smartphone_roi_pledge_applications(user_id, plan_id, reference, roi_amount, pledged_amount, applied_amount, outstanding_after)
    VALUES (p_user_id, v_plan.id, p_reference, p_roi_amount, v_pledged, v_amount, v_closing);
  BEGIN
    INSERT INTO public.system_events(event_type, user_id, metadata)
    VALUES ('payment_made', p_user_id, jsonb_build_object('kind','smartphone_roi_pledge_applied','amount',v_amount,'plan_id',v_plan.id,'reference',p_reference));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('applied', v_amount, 'outstanding_after', v_closing);
END $$;
REVOKE ALL ON FUNCTION public.apply_smartphone_roi_pledge(uuid,numeric,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_smartphone_roi_pledge(uuid,numeric,text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_my_smartphone_journey()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_sale record; v_plan record;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_sale FROM public.merchandise_sales s
   WHERE s.customer_id = v_uid AND s.item_name ILIKE '%smartphone%' AND s.cfo_disbursed_at IS NOT NULL
     AND COALESCE(s.amount_outstanding,0) > 0 AND s.settlement_completed_at IS NULL
   ORDER BY s.cfo_disbursed_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_plan FROM public.merchandise_recovery_plans WHERE sale_id = v_sale.id ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'sale_id', v_sale.id, 'item_name', v_sale.item_name, 'brand', v_sale.brand, 'model', v_sale.model_type,
    'device_amount', COALESCE(v_sale.disbursed_amount, v_sale.total_amount, v_sale.unit_price),
    'months', v_sale.advance_period_months,
    'total_repayable', COALESCE(v_plan.original_amount, v_sale.total_repayable),
    'outstanding', COALESCE(v_plan.outstanding_balance, v_sale.amount_outstanding),
    'paid', COALESCE(v_plan.amount_recovered, v_sale.amount_paid, 0),
    'daily_fixed', COALESCE(v_plan.daily_deduction_amount, v_sale.access_daily_amount),
    'starts_on', COALESCE(v_plan.starts_on, v_sale.repayment_starts_on),
    'released_at', v_sale.cfo_disbursed_at, 'grace_days', v_sale.grace_days,
    'schedule', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.month_index) FROM public.smartphone_repayment_schedules r WHERE r.sale_id = v_sale.id), '[]'::jsonb),
    'recent', COALESCE((SELECT jsonb_agg(x ORDER BY x.created_at DESC) FROM (SELECT d.amount, d.item_name, d.created_at FROM public.merchandise_recovery_deductions d WHERE d.plan_id = v_plan.id ORDER BY d.created_at DESC LIMIT 10) x), '[]'::jsonb),
    'has_portfolio', EXISTS (SELECT 1 FROM public.investor_portfolios WHERE investor_id = v_uid AND status = 'active'),
    'pledge', (SELECT to_jsonb(p) FROM public.smartphone_roi_pledges p WHERE p.user_id = v_uid)
  );
END $$;
GRANT EXECUTE ON FUNCTION public.get_my_smartphone_journey() TO authenticated;