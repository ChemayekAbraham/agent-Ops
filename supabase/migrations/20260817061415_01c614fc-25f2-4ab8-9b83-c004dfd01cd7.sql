ALTER TABLE public.merchandise_sales
  ADD COLUMN IF NOT EXISTS service_centre_id uuid REFERENCES public.service_centre_setups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS issued_channel text;

CREATE INDEX IF NOT EXISTS idx_merchandise_sales_customer ON public.merchandise_sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_merchandise_sales_service_centre ON public.merchandise_sales(service_centre_id);

CREATE OR REPLACE FUNCTION public._agent_products_authorized()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(auth.uid(), 'agent_ops')
      OR public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'coo')
      OR public.has_role(auth.uid(), 'ceo')
      OR public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'cmo')
      OR public.has_role(auth.uid(), 'super_admin')
$$;

CREATE OR REPLACE FUNCTION public.get_agent_products_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kpis jsonb;
  v_rows jsonb;
  v_catalog jsonb;
  v_centres jsonb;
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to view agent products';
  END IF;

  WITH agent_ids AS (
    SELECT DISTINCT user_id FROM public.user_roles WHERE role IN ('agent','senior_agent','sub_agent')
  ),
  field_sales AS (
    SELECT s.id, s.customer_id, s.item_name, s.quantity, s.total_revenue,
           s.amount_paid, s.amount_outstanding, s.sale_date, s.payment_plan,
           s.service_centre_id, s.created_at
    FROM public.merchandise_sales s
    JOIN agent_ids a ON a.user_id = s.customer_id
  ),
  plan_agg AS (
    SELECT p.sale_id,
           SUM(COALESCE(p.amount_recovered,0)) AS recovered,
           SUM(COALESCE(p.outstanding_balance,0)) AS outstanding
    FROM public.merchandise_recovery_plans p
    WHERE p.sale_id IS NOT NULL
    GROUP BY p.sale_id
  ),
  per_agent AS (
    SELECT f.customer_id AS agent_id,
           pr.full_name,
           pr.avatar_url,
           pr.phone,
           COALESCE(
             MAX(sc.location_name),
             MAX(sc2.location_name),
             MAX(pr.territory)
           ) AS location_name,
           SUM(COALESCE(f.quantity,1))::int AS items_held,
           COUNT(DISTINCT f.item_name)::int AS distinct_products,
           SUM(COALESCE(f.total_revenue,0)) AS held_amount,
           SUM(COALESCE(pa.recovered, f.amount_paid, 0)) AS repaid_amount,
           SUM(COALESCE(pa.outstanding, f.amount_outstanding, 0)) AS outstanding_amount,
           MAX(COALESCE(f.sale_date, f.created_at::date)) AS last_issued_on,
           jsonb_agg(DISTINCT f.item_name) AS product_names
    FROM field_sales f
    LEFT JOIN plan_agg pa ON pa.sale_id = f.id
    LEFT JOIN public.profiles pr ON pr.id = f.customer_id
    LEFT JOIN public.service_centre_setups sc ON sc.id = f.service_centre_id
    LEFT JOIN public.service_centre_setups sc2 ON sc2.agent_id = f.customer_id
    GROUP BY f.customer_id, pr.full_name, pr.avatar_url, pr.phone
  ),
  stock AS (
    SELECT
      (SELECT COALESCE(SUM(quantity),0) FROM public.merchandise_purchases) AS purchased_qty,
      (SELECT COALESCE(SUM(total_cost),0) FROM public.merchandise_purchases) AS purchased_value,
      (SELECT COALESCE(SUM(quantity),0) FROM public.merchandise_sales) AS sold_qty
  )
  SELECT
    jsonb_build_object(
      'total_products', (SELECT COUNT(*) FROM public.merchandise_catalog WHERE is_active),
      'in_field_items', COALESCE((SELECT SUM(items_held) FROM per_agent), 0),
      'in_field_agents', COALESCE((SELECT COUNT(*) FROM per_agent), 0),
      'in_field_amount', COALESCE((SELECT SUM(held_amount) FROM per_agent), 0),
      'in_field_outstanding', COALESCE((SELECT SUM(outstanding_amount) FROM per_agent), 0),
      'in_field_repaid', COALESCE((SELECT SUM(repaid_amount) FROM per_agent), 0),
      'purchased_qty', (SELECT purchased_qty FROM stock),
      'purchased_value', (SELECT purchased_value FROM stock),
      'stock_qty', GREATEST((SELECT purchased_qty - sold_qty FROM stock), 0),
      'service_centres', COALESCE((SELECT COUNT(DISTINCT location_name) FROM per_agent WHERE location_name IS NOT NULL), 0)
    ),
    COALESCE((SELECT jsonb_agg(to_jsonb(pa) ORDER BY pa.held_amount DESC) FROM per_agent pa), '[]'::jsonb)
  INTO v_kpis, v_rows;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', c.id, 'item_name', c.item_name,
           'unit_price', c.unit_price, 'unit_cost', c.unit_cost
         ) ORDER BY c.item_name), '[]'::jsonb)
  INTO v_catalog
  FROM public.merchandise_catalog c WHERE c.is_active;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', sc.id, 'location_name', sc.location_name,
           'agent_id', sc.agent_id, 'agent_name', sc.agent_name, 'status', sc.status
         ) ORDER BY sc.location_name), '[]'::jsonb)
  INTO v_centres
  FROM public.service_centre_setups sc
  WHERE sc.status IN ('pending','verified','approved');

  RETURN jsonb_build_object('kpis', v_kpis, 'rows', v_rows, 'catalog', v_catalog, 'centres', v_centres);
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_products_overview() FROM public;
GRANT EXECUTE ON FUNCTION public.get_agent_products_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.agent_ops_issue_agent_product(
  p_agent_id uuid,
  p_item_name text,
  p_quantity integer,
  p_unit_price numeric,
  p_unit_cost numeric DEFAULT 0,
  p_service_centre_id uuid DEFAULT NULL,
  p_payment_plan text DEFAULT 'installment',
  p_amount_paid numeric DEFAULT 0,
  p_notes text DEFAULT NULL
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

  RETURN v_sale;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_ops_issue_agent_product(uuid, text, integer, numeric, numeric, uuid, text, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.agent_ops_issue_agent_product(uuid, text, integer, numeric, numeric, uuid, text, numeric, text) TO authenticated;