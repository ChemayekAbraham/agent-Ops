CREATE OR REPLACE FUNCTION public.confirm_merchandise_handover(p_sale_id uuid, p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sale public.merchandise_sales; v_plan uuid;
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['cmo','agent_ops','manager','super_admin']) THEN
    RAISE EXCEPTION 'Only a company handler can confirm a handover';
  END IF;
  IF length(trim(COALESCE(p_note,''))) < 10 THEN RAISE EXCEPTION 'Add a handover note of at least 10 characters'; END IF;
  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_sale.fulfilment_type IS DISTINCT FROM 'company_issued' THEN RAISE EXCEPTION 'Only company issued items are handed over'; END IF;
  IF v_sale.handed_over_at IS NOT NULL THEN RAISE EXCEPTION 'This item was already handed over'; END IF;
  IF v_sale.order_status <> 'awaiting_handover' THEN
    RAISE EXCEPTION 'Order is not fully approved yet (status: %)', v_sale.order_status;
  END IF;
  UPDATE public.merchandise_sales
  SET handed_over_by = auth.uid(), handed_over_at = now(), handover_note = trim(p_note),
      order_status = 'issued', updated_at = now()
  WHERE id = p_sale_id;
  v_plan := public._merch_create_plan_for_sale(p_sale_id);
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 'merchandise_handover_confirmed', 'merchandise_sales', p_sale_id::text, trim(p_note),
          jsonb_build_object('item_name', v_sale.item_name, 'plan_id', v_plan));
  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, entity_type, entity_id, metadata)
    VALUES ('merchandise.handover_confirmed', auth.uid(), v_sale.customer_id, 'merchandise_sales', p_sale_id,
            jsonb_build_object('item_name', v_sale.item_name, 'total', v_sale.total_revenue));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN p_sale_id;
END $$;