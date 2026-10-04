CREATE OR REPLACE FUNCTION public.get_agent_products_overview(p_category text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kpis jsonb;
  v_rows jsonb;
  v_catalog jsonb;
  v_centres jsonb;
  v_cat text := lower(coalesce(p_category, ''));
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
    WHERE public.agent_product_category(s.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(s.item_name))
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
  cat_sales AS (
    SELECT s.quantity, s.item_name
    FROM public.merchandise_sales s
    WHERE public.agent_product_category(s.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(s.item_name))
  ),
  cat_purchases AS (
    SELECT p.quantity, p.total_cost
    FROM public.merchandise_purchases p
    WHERE public.agent_product_category(p.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(p.item_name))
  ),
  stock AS (
    SELECT
      (SELECT COALESCE(SUM(quantity),0) FROM cat_purchases) AS purchased_qty,
      (SELECT COALESCE(SUM(total_cost),0) FROM cat_purchases) AS purchased_value,
      (SELECT COALESCE(SUM(quantity),0) FROM cat_sales) AS sold_qty
  )
  SELECT
    jsonb_build_object(
      'total_products', (SELECT COUNT(*) FROM public.merchandise_catalog c
                         WHERE c.is_active
                           AND public.agent_product_category(c.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(c.item_name))),
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
  FROM public.merchandise_catalog c
  WHERE c.is_active
    AND public.agent_product_category(c.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(c.item_name));

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', sc.id, 'location_name', sc.location_name,
           'agent_id', sc.agent_id, 'agent_name', sc.agent_name, 'status', sc.status
         ) ORDER BY sc.location_name), '[]'::jsonb)
  INTO v_centres
  FROM public.service_centre_setups sc
  WHERE sc.status IN ('pending','verified','approved');

  RETURN jsonb_build_object('kpis', v_kpis, 'rows', v_rows, 'catalog', v_catalog, 'centres', v_centres);
END;
$function$;