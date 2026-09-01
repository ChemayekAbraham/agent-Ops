-- Detail: fall back to merchandise_sales.client_name / client_phone when the
-- agent profile is unlinked (overview keys unlinked rows by the sale id).
CREATE OR REPLACE FUNCTION public.get_agent_product_detail(p_agent_id uuid, p_category text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cat text := lower(coalesce(p_category, ''));
  v_out jsonb;
  v_client_name text;
  v_client_phone text;
  v_has_profile boolean := false;
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to view agent products';
  END IF;
  IF p_agent_id IS NULL THEN
    RAISE EXCEPTION 'Agent is required';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p_agent_id) INTO v_has_profile;

  -- Identity fallback from the sale rows themselves (linked or seed-by-sale-id)
  SELECT NULLIF(btrim(s.client_name), ''), NULLIF(btrim(s.client_phone), '')
    INTO v_client_name, v_client_phone
  FROM public.merchandise_sales s
  WHERE s.customer_id = p_agent_id OR s.id = p_agent_id
  ORDER BY (s.customer_id = p_agent_id) DESC, s.created_at DESC
  LIMIT 1;

  WITH agent_sales AS (
    SELECT s.*
    FROM public.merchandise_sales s
    WHERE (
        s.customer_id = p_agent_id
        OR s.id = p_agent_id
        OR (
          s.customer_id IS NULL
          AND v_client_name IS NOT NULL
          AND lower(btrim(s.client_name)) = lower(v_client_name)
        )
      )
      AND public.agent_product_category(s.item_name)
          = COALESCE(NULLIF(v_cat,''), public.agent_product_category(s.item_name))
  ),
  plan_agg AS (
    SELECT p.sale_id,
           SUM(COALESCE(p.amount_recovered,0))     AS recovered,
           SUM(COALESCE(p.outstanding_balance,0))  AS outstanding
    FROM public.merchandise_recovery_plans p
    WHERE p.sale_id IN (SELECT id FROM agent_sales)
    GROUP BY p.sale_id
  )
  SELECT jsonb_build_object(
    'agent', CASE WHEN v_has_profile THEN (
      SELECT jsonb_build_object(
        'id', pr.id,
        'full_name', COALESCE(pr.full_name, v_client_name),
        'avatar_url', pr.avatar_url,
        'phone', COALESCE(pr.phone, v_client_phone),
        'email', pr.email,
        'territory', pr.territory,
        'district', pr.district,
        'centre', (SELECT sc.location_name FROM public.service_centre_setups sc
                   WHERE sc.agent_id = pr.id ORDER BY sc.created_at DESC LIMIT 1),
        'roles', (SELECT COALESCE(jsonb_agg(DISTINCT ur.role::text), '[]'::jsonb)
                  FROM public.user_roles ur WHERE ur.user_id = pr.id)
      )
      FROM public.profiles pr WHERE pr.id = p_agent_id
    ) ELSE jsonb_build_object(
        'id', p_agent_id,
        'full_name', v_client_name,
        'avatar_url', NULL,
        'phone', v_client_phone,
        'email', NULL,
        'territory', NULL,
        'district', NULL,
        'centre', NULL,
        'roles', '[]'::jsonb
      ) END,
    'totals', (
      SELECT jsonb_build_object(
        'items', COALESCE(SUM(COALESCE(a.quantity,1)),0),
        'orders', COUNT(*),
        'billed', COALESCE(SUM(COALESCE(a.total_revenue,0)),0),
        'repaid', COALESCE(SUM(COALESCE(pa.recovered, a.amount_paid, 0)),0),
        'outstanding', COALESCE(SUM(COALESCE(pa.outstanding, a.amount_outstanding, 0)),0)
      )
      FROM agent_sales a LEFT JOIN plan_agg pa ON pa.sale_id = a.id
      WHERE lower(COALESCE(a.order_status,'issued'))
            NOT IN ('pending_approval','submitted','rejected','cancelled','declined')
    ),
    'items', (
      SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'sale_id', a.id,
          'item_name', a.item_name,
          'brand', a.brand,
          'model_type', a.model_type,
          'quantity', a.quantity,
          'amount', COALESCE(a.total_revenue,0),
          'repaid', COALESCE(pa.recovered, a.amount_paid, 0),
          'outstanding', COALESCE(pa.outstanding, a.amount_outstanding, 0),
          'order_status', COALESCE(a.order_status,'issued'),
          'payment_plan', a.payment_plan,
          'sale_date', a.sale_date,
          'created_at', a.created_at
        ) AS x
        FROM agent_sales a LEFT JOIN plan_agg pa ON pa.sale_id = a.id
      ) s
    ),
    'plans', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', p.id,
        'item_name', p.item_name,
        'original_amount', COALESCE(p.original_amount,0),
        'amount_recovered', COALESCE(p.amount_recovered,0),
        'outstanding_balance', COALESCE(p.outstanding_balance,0),
        'daily_deduction_amount', COALESCE(p.daily_deduction_amount, p.daily_rate, 0),
        'status', p.status,
        'starts_on', p.starts_on,
        'last_recovery_at', p.last_recovery_at
      ) ORDER BY p.created_at DESC), '[]'::jsonb)
      FROM public.merchandise_recovery_plans p
      WHERE (p.customer_id = p_agent_id OR p.sale_id IN (SELECT id FROM agent_sales))
        AND public.agent_product_category(p.item_name)
            = COALESCE(NULLIF(v_cat,''), public.agent_product_category(p.item_name))
    ),
    'deductions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', d.id,
        'item_name', d.item_name,
        'amount', COALESCE(d.amount,0),
        'outstanding_after', COALESCE(d.outstanding_after,0),
        'transaction_ref', d.transaction_ref,
        'created_at', d.created_at
      ) ORDER BY d.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT d2.* FROM public.merchandise_recovery_deductions d2
        WHERE (
            d2.customer_id = p_agent_id
            OR d2.plan_id IN (
              SELECT p2.id FROM public.merchandise_recovery_plans p2
              WHERE p2.sale_id IN (SELECT id FROM agent_sales)
            )
          )
          AND public.agent_product_category(d2.item_name)
              = COALESCE(NULLIF(v_cat,''), public.agent_product_category(d2.item_name))
        ORDER BY d2.created_at DESC
        LIMIT 100
      ) d
    )
  ) INTO v_out;

  RETURN COALESCE(v_out, '{}'::jsonb);
END;
$function$;

-- Delete: match by customer_id, by sale id (unlinked seed key) or by recorded client_name.
CREATE OR REPLACE FUNCTION public.delete_agent_product_holdings(
  p_agent_id uuid,
  p_category text DEFAULT NULL::text,
  p_reason text DEFAULT NULL::text,
  p_client_name text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cat text := lower(coalesce(p_category, ''));
  v_sale_ids uuid[];
  v_plan_ids uuid[];
  v_name text := NULLIF(btrim(p_client_name), '');
  v_deleted_sales int := 0;
  v_deleted_plans int := 0;
  v_deleted_deductions int := 0;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'employee')
    OR public.has_role(auth.uid(), 'operations')
  ) THEN
    RAISE EXCEPTION 'Not authorized to delete agent product records';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  IF v_name IS NULL THEN
    SELECT NULLIF(btrim(s.client_name), '') INTO v_name
    FROM public.merchandise_sales s
    WHERE s.customer_id = p_agent_id OR s.id = p_agent_id
    ORDER BY (s.customer_id = p_agent_id) DESC, s.created_at DESC
    LIMIT 1;
  END IF;

  SELECT array_agg(s.id) INTO v_sale_ids
  FROM public.merchandise_sales s
  WHERE (
      s.customer_id = p_agent_id
      OR s.id = p_agent_id
      OR (s.customer_id IS NULL AND v_name IS NOT NULL AND lower(btrim(s.client_name)) = lower(v_name))
    )
    AND public.agent_product_category(s.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(s.item_name));

  SELECT array_agg(p.id) INTO v_plan_ids
  FROM public.merchandise_recovery_plans p
  WHERE (v_sale_ids IS NOT NULL AND p.sale_id = ANY(v_sale_ids))
     OR (
       p.customer_id = p_agent_id
       AND public.agent_product_category(p.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(p.item_name))
     );

  IF (v_sale_ids IS NULL OR array_length(v_sale_ids, 1) IS NULL)
     AND (v_plan_ids IS NULL OR array_length(v_plan_ids, 1) IS NULL) THEN
    RETURN jsonb_build_object('deleted_sales', 0, 'deleted_plans', 0, 'deleted_deductions', 0);
  END IF;

  IF v_plan_ids IS NOT NULL AND array_length(v_plan_ids, 1) > 0 THEN
    WITH deleted_deductions AS (
      DELETE FROM public.merchandise_recovery_deductions
      WHERE plan_id = ANY(v_plan_ids)
      RETURNING id
    )
    SELECT count(*) INTO v_deleted_deductions FROM deleted_deductions;

    WITH deleted_plans AS (
      DELETE FROM public.merchandise_recovery_plans
      WHERE id = ANY(v_plan_ids)
      RETURNING id, sale_id
    )
    SELECT count(*), array_agg(DISTINCT sale_id) FILTER (WHERE sale_id IS NOT NULL)
      INTO v_deleted_plans, v_plan_ids
    FROM deleted_plans;

    IF v_plan_ids IS NOT NULL THEN
      SELECT array_agg(DISTINCT s.id) INTO v_sale_ids
      FROM public.merchandise_sales s
      WHERE s.id = ANY(COALESCE(v_sale_ids, ARRAY[]::uuid[]) || v_plan_ids);
    END IF;
  END IF;

  IF v_sale_ids IS NOT NULL AND array_length(v_sale_ids, 1) > 0 THEN
    WITH deleted_sales AS (
      DELETE FROM public.merchandise_sales WHERE id = ANY(v_sale_ids)
      RETURNING id
    )
    SELECT count(*) INTO v_deleted_sales FROM deleted_sales;
  END IF;

  INSERT INTO public.audit_logs (
    action_type, table_name, record_id, user_id, reason, metadata
  )
  VALUES (
    'delete',
    'merchandise_sales',
    p_agent_id::text,
    auth.uid(),
    p_reason,
    jsonb_build_object(
      'category', v_cat,
      'client_name', v_name,
      'deleted_sales', v_deleted_sales,
      'deleted_plans', v_deleted_plans,
      'deleted_deductions', v_deleted_deductions
    )
  );

  RETURN jsonb_build_object(
    'deleted_sales', v_deleted_sales,
    'deleted_plans', v_deleted_plans,
    'deleted_deductions', v_deleted_deductions
  );
END;
$function$;