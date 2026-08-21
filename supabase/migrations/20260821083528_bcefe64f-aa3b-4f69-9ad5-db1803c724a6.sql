CREATE OR REPLACE FUNCTION public.create_merchandise_recovery_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer uuid;
  v_name text;
  v_rate numeric;
  v_item text;
BEGIN
  IF COALESCE(NEW.amount_outstanding, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_customer := NEW.customer_id;
  IF v_customer IS NULL AND NEW.client_phone IS NOT NULL
     AND public.normalize_phone_9(NEW.client_phone) <> '' THEN
    SELECT id INTO v_customer
    FROM public.profiles
    WHERE public.normalize_phone_9(phone) = public.normalize_phone_9(NEW.client_phone)
    LIMIT 1;
  END IF;

  IF v_customer IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  v_item := lower(COALESCE(NEW.item_name, ''));
  IF v_item LIKE '%phone%' OR v_item LIKE '%bike%' THEN
    v_rate := 0.33;
  ELSE
    v_rate := CASE WHEN COALESCE(NEW.payment_plan, 'full') = 'installment' THEN 0.25 ELSE 0.15 END;
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
$$;

DROP FUNCTION IF EXISTS public.agent_ops_issue_agent_product(uuid, text, integer, numeric, numeric, uuid, text, numeric, text);

CREATE OR REPLACE FUNCTION public.agent_ops_issue_agent_product(
  p_agent_id uuid,
  p_item_name text,
  p_quantity integer,
  p_unit_price numeric,
  p_unit_cost numeric,
  p_service_centre_id uuid,
  p_payment_plan text,
  p_amount_paid numeric,
  p_notes text,
  p_recovery_rate numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric;
  v_paid numeric;
  v_sale uuid;
  v_profile record;
  v_rate numeric;
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to issue agent products';
  END IF;
  IF p_agent_id IS NULL OR COALESCE(TRIM(p_item_name),'') = '' THEN
    RAISE EXCEPTION 'Agent and product are required';
  END IF;
  IF COALESCE(p_quantity,0) <= 0 OR COALESCE(p_unit_price,0) <= 0 THEN
    RAISE EXCEPTION 'Quantity and unit price must be greater than zero';
  END IF;
  IF COALESCE(p_payment_plan,'installment') NOT IN ('full','installment') THEN
    RAISE EXCEPTION 'Invalid payment plan';
  END IF;
  IF p_recovery_rate IS NOT NULL AND (p_recovery_rate <= 0 OR p_recovery_rate > 1) THEN
    RAISE EXCEPTION 'Recovery rate must be between 0 and 1';
  END IF;

  SELECT full_name, phone INTO v_profile FROM public.profiles WHERE id = p_agent_id;
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'Agent profile not found';
  END IF;

  v_total := p_quantity * p_unit_price;
  v_paid := LEAST(GREATEST(COALESCE(p_amount_paid,0), 0), v_total);
  IF COALESCE(p_payment_plan,'installment') = 'full' THEN
    v_paid := v_total;
  END IF;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, notes,
    payment_plan, order_status, service_centre_id, issued_channel, created_by
  ) VALUES (
    TRIM(p_item_name), p_quantity, p_unit_price, COALESCE(p_unit_cost,0), v_total,
    v_profile.full_name, v_profile.phone, p_agent_id,
    CASE WHEN v_paid >= v_total THEN 'paid' WHEN v_paid > 0 THEN 'partial' ELSE 'credit' END,
    v_paid, v_total - v_paid, CURRENT_DATE, p_notes,
    COALESCE(p_payment_plan,'installment'), 'approved', p_service_centre_id, 'agent_ops', auth.uid()
  ) RETURNING id INTO v_sale;

  v_rate := p_recovery_rate;
  IF v_rate IS NULL AND (lower(TRIM(p_item_name)) LIKE '%phone%' OR lower(TRIM(p_item_name)) LIKE '%bike%') THEN
    v_rate := 0.33;
  END IF;

  IF v_rate IS NOT NULL THEN
    UPDATE public.merchandise_recovery_plans
    SET daily_rate = v_rate
    WHERE sale_id = v_sale;
  END IF;

  RETURN v_sale;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_ops_issue_agent_product(uuid, text, integer, numeric, numeric, uuid, text, numeric, text, numeric) TO authenticated;