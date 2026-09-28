CREATE OR REPLACE FUNCTION public.list_boutique_approval_queue(p_stage text)
RETURNS TABLE(sale_id uuid, item_name text, quantity integer, selected_size text, total_revenue numeric, amount_outstanding numeric, payment_plan text, order_status text, customer_id uuid, agent_name text, agent_phone text, created_at timestamp with time zone, ops_approved_at timestamp with time zone, coo_approved_at timestamp with time zone, cfo_disbursed_at timestamp with time zone)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_stage = 'coo' THEN
    IF NOT (public.has_role(auth.uid(),'coo') OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'manager')) THEN
      RAISE EXCEPTION 'Not authorized';
    END IF;
  ELSIF p_stage = 'cfo' THEN
    IF NOT (public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'super_admin')) THEN
      RAISE EXCEPTION 'Not authorized';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown stage %', p_stage;
  END IF;

  RETURN QUERY
  SELECT s.id, s.item_name, s.quantity, s.selected_size, s.total_revenue, s.amount_outstanding,
         s.payment_plan, s.order_status, s.customer_id, p.full_name, p.phone, s.created_at,
         s.ops_approved_at, s.coo_approved_at, s.cfo_disbursed_at
  FROM public.merchandise_sales s
  LEFT JOIN public.profiles p ON p.id = s.customer_id
  WHERE public.agent_product_category(s.item_name) = 'boutique'
    AND (
      -- COO only sees orders Agent Ops has already approved (plus its own recent approvals)
      (p_stage = 'coo' AND s.order_status IN ('ops_approved','coo_approved'))
   OR (p_stage = 'cfo' AND (s.order_status = 'coo_approved'
            OR (s.cfo_disbursed_at IS NOT NULL AND s.cfo_disbursed_at > now() - interval '30 days')))
    )
  ORDER BY (s.order_status IN ('coo_approved','issued','completed')), s.created_at DESC
  LIMIT 500;
END;
$function$;

CREATE OR REPLACE FUNCTION public.coo_approve_boutique_order(p_sale_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_sale record;
BEGIN
  IF NOT (public.has_role(auth.uid(),'coo') OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'manager')) THEN
    RAISE EXCEPTION 'Only the COO can approve boutique orders';
  END IF;
  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF public.agent_product_category(v_sale.item_name) <> 'boutique' THEN RAISE EXCEPTION 'Not a boutique order'; END IF;
  IF v_sale.order_status = 'coo_approved' THEN RETURN p_sale_id; END IF;
  -- Agent Ops must approve first; the COO cannot skip that stage
  IF v_sale.order_status <> 'ops_approved' THEN
    RAISE EXCEPTION 'Agent Ops must approve this order first (current status: %)', v_sale.order_status;
  END IF;
  UPDATE public.merchandise_sales
  SET order_status = 'coo_approved', coo_approved_by = auth.uid(), coo_approved_at = now(), updated_at = now()
  WHERE id = p_sale_id;
  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, entity_type, entity_id, metadata)
    VALUES ('merchandise.boutique_coo_approved', auth.uid(), v_sale.customer_id, 'merchandise_sales', p_sale_id,
            jsonb_build_object('item_name', v_sale.item_name, 'total', v_sale.total_revenue));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN p_sale_id;
END;
$function$;