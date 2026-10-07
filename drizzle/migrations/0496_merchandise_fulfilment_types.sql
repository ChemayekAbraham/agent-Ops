ALTER TABLE public.merchandise_catalog ADD COLUMN IF NOT EXISTS fulfilment_type text;
ALTER TABLE public.merchandise_sales ADD COLUMN IF NOT EXISTS fulfilment_type text,
  ADD COLUMN IF NOT EXISTS handed_over_by uuid,
  ADD COLUMN IF NOT EXISTS handed_over_at timestamptz,
  ADD COLUMN IF NOT EXISTS handover_note text;

UPDATE public.merchandise_catalog SET fulfilment_type = 'company_issued'
WHERE lower(trim(item_name)) IN ('company ids','jumper white','press jacket','table mount','welile customized','welile evidence','welile jumper','welile polo','welile polo black','light signage','customized bill board','pull-up signage','signages');
UPDATE public.merchandise_catalog SET fulfilment_type = 'outsourced'
WHERE lower(trim(item_name)) IN ('audrey chair','black chair','laptops','office chair','office table','scholar chair','table','waiting chair');

ALTER TABLE public.merchandise_catalog ADD CONSTRAINT merchandise_catalog_fulfilment_type_ck CHECK (fulfilment_type IS NULL OR fulfilment_type IN ('company_issued','outsourced'));
ALTER TABLE public.merchandise_sales ADD CONSTRAINT merchandise_sales_fulfilment_type_ck CHECK (fulfilment_type IS NULL OR fulfilment_type IN ('company_issued','outsourced'));

ALTER TABLE public.merchandise_sales DROP CONSTRAINT IF EXISTS merchandise_sales_order_status_check;
ALTER TABLE public.merchandise_sales ADD CONSTRAINT merchandise_sales_order_status_check CHECK (order_status = ANY (ARRAY['pending_approval','submitted','ops_approved','coo_approved','approved','processing','awaiting_handover','issued','completed','failed','rejected']));

-- Stamp the category on every new order from the catalog (covers every order RPC).
CREATE OR REPLACE FUNCTION public.trg_merch_stamp_fulfilment_type()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.fulfilment_type IS NULL THEN
    SELECT c.fulfilment_type INTO NEW.fulfilment_type FROM public.merchandise_catalog c
    WHERE lower(trim(c.item_name)) = lower(trim(NEW.item_name)) AND c.fulfilment_type IS NOT NULL
    ORDER BY c.is_active DESC LIMIT 1;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_merch_stamp_fulfilment_type ON public.merchandise_sales;
CREATE TRIGGER trg_merch_stamp_fulfilment_type BEFORE INSERT ON public.merchandise_sales
FOR EACH ROW EXECUTE FUNCTION public.trg_merch_stamp_fulfilment_type();

-- Company-issued orders never jump straight to 'issued': the final approval parks them for physical handover.
CREATE OR REPLACE FUNCTION public.trg_merch_hold_for_handover()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.fulfilment_type = 'company_issued' AND NEW.order_status = 'issued'
     AND COALESCE(OLD.order_status,'') NOT IN ('issued','completed') AND NEW.handed_over_at IS NULL THEN
    NEW.order_status := 'awaiting_handover';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_merch_hold_for_handover ON public.merchandise_sales;
CREATE TRIGGER trg_merch_hold_for_handover BEFORE UPDATE OF order_status ON public.merchandise_sales
FOR EACH ROW EXECUTE FUNCTION public.trg_merch_hold_for_handover();

-- Idempotent plan creation for a sale (one plan per sale).
CREATE OR REPLACE FUNCTION public._merch_create_plan_for_sale(p_sale_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.merchandise_sales; v_plan uuid; v_name text; v_rate numeric;
BEGIN
  SELECT * INTO s FROM public.merchandise_sales WHERE id = p_sale_id;
  IF s.id IS NULL OR s.customer_id IS NULL OR COALESCE(s.amount_outstanding,0) <= 0 THEN RETURN NULL; END IF;
  SELECT id INTO v_plan FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id LIMIT 1;
  IF v_plan IS NOT NULL THEN RETURN v_plan; END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = s.customer_id;
  v_rate := CASE WHEN COALESCE(s.payment_plan,'full') = 'installment' THEN 0.25 ELSE 0.15 END;
  INSERT INTO public.merchandise_recovery_plans (sale_id, customer_id, customer_name, customer_phone, item_name,
    original_amount, outstanding_balance, daily_rate, created_by)
  VALUES (s.id, s.customer_id, COALESCE(v_name, s.client_name), s.client_phone, s.item_name,
    s.amount_outstanding, s.amount_outstanding, v_rate, COALESCE(auth.uid(), s.created_by))
  RETURNING id INTO v_plan;
  RETURN v_plan;
END $$;
REVOKE ALL ON FUNCTION public._merch_create_plan_for_sale(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_merchandise_recovery_plan()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_customer uuid; v_name text; v_rate numeric; v_item text;
BEGIN
  IF COALESCE(NEW.amount_outstanding, 0) <= 0 THEN RETURN NEW; END IF;
  -- Categorised orders start repayment only at handover (company issued) or CFO disbursement (out-sourced).
  IF NEW.fulfilment_type IS NOT NULL THEN RETURN NEW; END IF;
  IF lower(COALESCE(NEW.item_name,'')) LIKE '%spiro%'
     OR public.agent_product_category(NEW.item_name) = 'motor_bike' THEN
    RETURN NEW;
  END IF;
  v_customer := NEW.customer_id;
  IF v_customer IS NULL AND NEW.client_phone IS NOT NULL
     AND public.normalize_phone_9(NEW.client_phone) <> '' THEN
    SELECT id INTO v_customer FROM public.profiles
    WHERE public.normalize_phone_9(phone) = public.normalize_phone_9(NEW.client_phone) LIMIT 1;
  END IF;
  IF v_customer IS NULL THEN RETURN NEW; END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;
  v_item := lower(COALESCE(NEW.item_name, ''));
  IF v_item LIKE '%phone%' OR v_item LIKE '%bike%' THEN v_rate := 0.33;
  ELSE v_rate := CASE WHEN COALESCE(NEW.payment_plan, 'full') = 'installment' THEN 0.25 ELSE 0.15 END;
  END IF;
  INSERT INTO public.merchandise_recovery_plans (
    sale_id, customer_id, customer_name, customer_phone, item_name,
    original_amount, outstanding_balance, daily_rate, created_by
  ) VALUES (
    NEW.id, v_customer, COALESCE(v_name, NEW.client_name), NEW.client_phone, NEW.item_name,
    NEW.amount_outstanding, NEW.amount_outstanding, v_rate, NEW.created_by
  );
  RETURN NEW;
END;
$function$;

-- CFO final approval: company issued -> parked for handover; out-sourced -> money to agent wallet + plan.
CREATE OR REPLACE FUNCTION public.cfo_issue_boutique_order(p_sale_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_sale record; v_ref text; v_group uuid; v_amt numeric; v_name text;
BEGIN
  IF NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can give final approval and issue boutique orders';
  END IF;
  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF public.agent_product_category(v_sale.item_name) <> 'boutique' THEN RAISE EXCEPTION 'Not a boutique order'; END IF;
  IF v_sale.order_status IN ('issued','completed','awaiting_handover') THEN RETURN p_sale_id; END IF;
  IF v_sale.order_status <> 'coo_approved' THEN
    RAISE EXCEPTION 'Order must be approved by the COO first (status: %)', v_sale.order_status;
  END IF;

  IF v_sale.fulfilment_type = 'outsourced' THEN
    IF v_sale.customer_id IS NULL THEN RAISE EXCEPTION 'Order has no linked agent account'; END IF;
    v_amt := COALESCE(NULLIF(v_sale.amount_outstanding,0), v_sale.total_revenue, 0);
    IF v_amt <= 0 THEN RAISE EXCEPTION 'Order amount is missing'; END IF;
    SELECT full_name INTO v_name FROM public.profiles WHERE id = v_sale.customer_id;
    v_ref := 'merch-outsourced-disburse-' || p_sale_id::text;
    IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_ref) THEN
      v_group := public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_sale.customer_id, 'amount', v_amt, 'direction', 'cash_in',
            'category', 'wallet_deposit', 'ledger_scope', 'wallet', 'recipient_type', 'user',
            'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_sales', 'source_id', p_sale_id,
            'reference_id', v_ref, 'currency', 'UGX',
            'description', 'Merchandise funds to buy ' || COALESCE(v_sale.item_name,'item'), 'transaction_date', now()),
          jsonb_build_object('user_id', auth.uid(), 'amount', v_amt, 'direction', 'cash_out',
            'category', 'equipment_expense', 'ledger_scope', 'platform',
            'source_table', 'merchandise_sales', 'source_id', p_sale_id,
            'reference_id', v_ref, 'currency', 'UGX',
            'description', 'Out-sourced merchandise funds for ' || COALESCE(v_name,'agent') || ' - ' || COALESCE(v_sale.item_name,'item'),
            'transaction_date', now())
        ), v_ref);
    END IF;
    UPDATE public.merchandise_sales
    SET order_status = 'issued', cfo_disbursed_by = auth.uid(), cfo_disbursed_at = now(),
        disbursed_amount = v_amt, disbursement_group_id = COALESCE(v_group, disbursement_group_id), updated_at = now()
    WHERE id = p_sale_id;
    PERFORM public._merch_create_plan_for_sale(p_sale_id);
  ELSE
    UPDATE public.merchandise_sales
    SET order_status = 'issued', cfo_disbursed_by = auth.uid(), cfo_disbursed_at = now(), updated_at = now()
    WHERE id = p_sale_id;
  END IF;

  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, entity_type, entity_id, metadata)
    VALUES ('merchandise.boutique_cfo_issued', auth.uid(), v_sale.customer_id, 'merchandise_sales', p_sale_id,
            jsonb_build_object('item_name', v_sale.item_name, 'total', v_sale.total_revenue, 'fulfilment_type', v_sale.fulfilment_type));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN p_sale_id;
END;
$function$;

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
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (auth.uid(), 'merchandise_handover_confirmed', 'merchandise_sales', p_sale_id::text,
          jsonb_build_object('reason', trim(p_note), 'item_name', v_sale.item_name, 'plan_id', v_plan));
  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, entity_type, entity_id, metadata)
    VALUES ('merchandise.handover_confirmed', auth.uid(), v_sale.customer_id, 'merchandise_sales', p_sale_id,
            jsonb_build_object('item_name', v_sale.item_name, 'total', v_sale.total_revenue));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN p_sale_id;
END $$;
REVOKE ALL ON FUNCTION public.confirm_merchandise_handover(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_merchandise_handover(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_merchandise_handover_queue()
RETURNS TABLE(sale_id uuid, item_name text, quantity integer, selected_size text, total_revenue numeric,
  agent_name text, agent_phone text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['cmo','agent_ops','manager','super_admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN QUERY SELECT s.id, s.item_name, s.quantity, s.selected_size, s.total_revenue, p.full_name, p.phone, s.created_at
  FROM public.merchandise_sales s LEFT JOIN public.profiles p ON p.id = s.customer_id
  WHERE s.order_status = 'awaiting_handover' ORDER BY s.created_at;
END $$;
REVOKE ALL ON FUNCTION public.list_merchandise_handover_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_merchandise_handover_queue() TO authenticated;