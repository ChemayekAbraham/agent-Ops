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
  BEGIN
    INSERT INTO public.system_events(event_type, user_id, metadata)
    VALUES ('wallet_transfer', v_uid, jsonb_build_object('kind','smartphone_roi_pledge_set','mode',p_mode,'value',p_value,'active',p_active));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('ok', true);
END $$;