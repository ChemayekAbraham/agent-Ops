-- Boutique orders: Agent Ops no longer issues directly; COO approves, CFO issues.
CREATE OR REPLACE FUNCTION public.agent_ops_approve_merchandise_order(p_sale_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_status text; v_item text;
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to approve agent product applications';
  END IF;
  SELECT lower(COALESCE(order_status,'')), item_name INTO v_status, v_item
  FROM public.merchandise_sales WHERE id = p_sale_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Application not found'; END IF;
  IF v_status IN ('rejected','cancelled','declined') THEN RAISE EXCEPTION 'Application is already closed'; END IF;

  IF public.agent_product_category(v_item) = 'boutique' THEN
    IF v_status NOT IN ('pending_approval','submitted','processing') THEN
      RAISE EXCEPTION 'Boutique order is already past Agent Ops review (status: %)', v_status;
    END IF;
    UPDATE public.merchandise_sales
    SET order_status = 'ops_approved', ops_approved_by = auth.uid(), ops_approved_at = now(), updated_at = now()
    WHERE id = p_sale_id;
    RETURN p_sale_id;
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'issued', ops_approved_by = auth.uid(), ops_approved_at = now(), updated_at = now()
  WHERE id = p_sale_id;
  RETURN p_sale_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_boutique_approval_queue(p_stage text)
 RETURNS TABLE(sale_id uuid, item_name text, quantity integer, selected_size text, total_revenue numeric,
   amount_outstanding numeric, payment_plan text, order_status text, customer_id uuid, agent_name text,
   agent_phone text, created_at timestamptz, ops_approved_at timestamptz, coo_approved_at timestamptz,
   cfo_disbursed_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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
      (p_stage = 'coo' AND s.order_status IN ('pending_approval','submitted','processing','ops_approved','coo_approved'))
   OR (p_stage = 'cfo' AND (s.order_status = 'coo_approved'
            OR (s.cfo_disbursed_at IS NOT NULL AND s.cfo_disbursed_at > now() - interval '30 days')))
    )
  ORDER BY (s.order_status IN ('coo_approved','issued','completed')), s.created_at DESC
  LIMIT 500;
END;
$function$;

CREATE OR REPLACE FUNCTION public.coo_approve_boutique_order(p_sale_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_sale record;
BEGIN
  IF NOT (public.has_role(auth.uid(),'coo') OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'manager')) THEN
    RAISE EXCEPTION 'Only the COO can give initial approval to boutique orders';
  END IF;
  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF public.agent_product_category(v_sale.item_name) <> 'boutique' THEN RAISE EXCEPTION 'Not a boutique order'; END IF;
  IF v_sale.order_status = 'coo_approved' THEN RETURN p_sale_id; END IF;
  IF v_sale.order_status NOT IN ('pending_approval','submitted','processing','ops_approved') THEN
    RAISE EXCEPTION 'Order cannot be approved from status %', v_sale.order_status;
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

CREATE OR REPLACE FUNCTION public.cfo_issue_boutique_order(p_sale_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_sale record;
BEGIN
  IF NOT (public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Only the CFO can give final approval and issue boutique orders';
  END IF;
  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF public.agent_product_category(v_sale.item_name) <> 'boutique' THEN RAISE EXCEPTION 'Not a boutique order'; END IF;
  IF v_sale.order_status IN ('issued','completed') THEN RETURN p_sale_id; END IF;
  IF v_sale.order_status <> 'coo_approved' THEN
    RAISE EXCEPTION 'Order must be approved by the COO first (status: %)', v_sale.order_status;
  END IF;
  -- Issuance only changes status; the recovery plan already exists from order creation. No money moves here.
  UPDATE public.merchandise_sales
  SET order_status = 'issued', cfo_disbursed_by = auth.uid(), cfo_disbursed_at = now(), updated_at = now()
  WHERE id = p_sale_id;
  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, entity_type, entity_id, metadata)
    VALUES ('merchandise.boutique_cfo_issued', auth.uid(), v_sale.customer_id, 'merchandise_sales', p_sale_id,
            jsonb_build_object('item_name', v_sale.item_name, 'total', v_sale.total_revenue));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN p_sale_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_boutique_approval_queue(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.coo_approve_boutique_order(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_issue_boutique_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_boutique_approval_queue(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.coo_approve_boutique_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_issue_boutique_order(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_merchandise_purchase(p_sale_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_sale         record;
  v_plan         record;
  v_refund       numeric := 0;
  v_path         text;
  v_tid          uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'cmo'::app_role)
    OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role)
    OR public.has_role(v_uid, 'cfo'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only CMO, COO, CFO, Manager, or Super Admin can reject purchase requests';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A rejection reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_sale
  FROM public.merchandise_sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  -- Idempotent
  IF v_sale.order_status = 'rejected' THEN
    RETURN jsonb_build_object(
      'sale_id', v_sale.id,
      'already_rejected', true,
      'refunded', 0
    );
  END IF;

  IF v_sale.order_status NOT IN ('submitted','processing','pending_approval','ops_approved','coo_approved') THEN
    RAISE EXCEPTION 'Only submitted, processing, pending_approval or ops_approved orders can be rejected (current: %)', v_sale.order_status;
  END IF;

  IF v_sale.customer_id IS NULL THEN
    RAISE EXCEPTION 'This sale has no linked customer wallet to refund';
  END IF;

  -- Detect refund path via recovery plan
  SELECT * INTO v_plan
  FROM public.merchandise_recovery_plans
  WHERE sale_id = v_sale.id
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_path   := 'recovery_plan';
    v_refund := COALESCE(v_plan.amount_recovered, 0);

    -- Cancel the plan
    UPDATE public.merchandise_recovery_plans
    SET status = 'cancelled',
        outstanding_balance = 0,
        updated_at = now()
    WHERE id = v_plan.id;
  ELSE
    v_path   := 'instant';
    v_refund := COALESCE(v_sale.total_revenue, 0);
  END IF;

  -- Refund the wallet via balanced ledger legs (only when there is money to move back)
  IF v_refund > 0 THEN
    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', v_sale.customer_id,
          'ledger_scope', 'wallet',
          'direction', 'cash_in',
          'amount', v_refund,
          'category', 'system_balance_correction',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_sales',
          'source_id', v_sale.id,
          'description', 'Merchandise Purchase Refund – ' || v_sale.item_name,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', 'merchandise_purchase_reject',
            'sale_id', v_sale.id,
            'refund_path', v_path,
            'rejected_by', v_uid,
            'reason', p_reason
          )
        ),
        jsonb_build_object(
          'user_id', v_sale.customer_id,
          'ledger_scope', 'platform',
          'direction', 'cash_out',
          'amount', v_refund,
          'category', 'system_balance_correction',
          'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_sales',
          'source_id', v_sale.id,
          'description', 'Merchandise Purchase Refund – ' || v_sale.item_name,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', 'merchandise_purchase_reject',
            'sale_id', v_sale.id,
            'refund_path', v_path,
            'rejected_by', v_uid,
            'reason', p_reason
          )
        )
      ),
      idempotency_key => 'merch_reject_' || v_sale.id::text,
      skip_balance_check => true
    );
  END IF;

  -- Mark the sale rejected
  UPDATE public.merchandise_sales
  SET order_status       = 'rejected',
      rejection_reason   = p_reason,
      rejected_by        = v_uid,
      rejected_at        = now(),
      amount_outstanding = 0,
      updated_at         = now()
  WHERE id = v_sale.id;

  -- Audit trail
  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, reason, metadata
  ) VALUES (
    v_uid,
    'merchandise_purchase_rejected',
    'merchandise_sales',
    v_sale.id,
    p_reason,
    jsonb_build_object(
      'refund_path', v_path,
      'refunded', v_refund,
      'item_name', v_sale.item_name,
      'customer_id', v_sale.customer_id
    )
  );

  -- System event (best-effort — do not fail the reject if the events table
  -- validator rejects the payload)
  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, metadata)
    VALUES (
      'merchandise.purchase_rejected',
      v_uid,
      jsonb_build_object(
        'sale_id', v_sale.id,
        'customer_id', v_sale.customer_id,
        'item_name', v_sale.item_name,
        'refunded', v_refund,
        'refund_path', v_path,
        'reason', p_reason
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', v_sale.id,
    'refunded', v_refund,
    'refund_path', v_path,
    'already_rejected', false
  );
END;
$function$;