-- Additive only: expose the recorded repayment duration alongside each item and
-- recovery plan, plus the daily amount implied by that schedule, so the dialog can
-- show the instalment instead of the full lump sum. No posting or recovery logic
-- is changed; every existing key keeps its meaning.
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
  ),
  -- Recorded repayment duration per sale: explicit repayment days when captured,
  -- otherwise the month term expressed in days (30-day months, as the order form).
  sale_term AS (
    SELECT a.id AS sale_id,
           NULLIF(a.advance_period_months, 0) AS period_months,
           NULLIF(a.access_repayment_days, 0) AS repayment_days,
           COALESCE(NULLIF(a.access_repayment_days, 0),
                    NULLIF(a.advance_period_months, 0) * 30) AS schedule_days,
           NULLIF(a.access_daily_amount, 0) AS recorded_daily
    FROM agent_sales a
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
          'advance_period_months', st.period_months,
          'access_repayment_days', st.repayment_days,
          'schedule_days', st.schedule_days,
          'scheduled_daily_amount',
            CASE WHEN COALESCE(st.schedule_days,0) > 0
                 THEN ROUND(COALESCE(a.total_repayable, a.total_revenue, 0) / st.schedule_days)
                 ELSE st.recorded_daily END,
          'repayment_starts_on', a.repayment_starts_on,
          'sale_date', a.sale_date,
          'created_at', a.created_at
        ) AS x
        FROM agent_sales a
        LEFT JOIN plan_agg pa ON pa.sale_id = a.id
        LEFT JOIN sale_term st ON st.sale_id = a.id
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
        'advance_period_months', st.period_months,
        'access_repayment_days', st.repayment_days,
        'schedule_days', st.schedule_days,
        -- Instalment implied by the recorded schedule. Falls back to the stored
        -- daily amount only when no duration was captured on the order.
        'scheduled_daily_amount',
          CASE WHEN COALESCE(st.schedule_days,0) > 0
               THEN ROUND(COALESCE(p.original_amount,0) / st.schedule_days)
               ELSE COALESCE(st.recorded_daily, p.daily_deduction_amount, p.daily_rate, 0) END,
        'status', p.status,
        'starts_on', p.starts_on,
        'last_recovery_at', p.last_recovery_at
      ) ORDER BY p.created_at DESC), '[]'::jsonb)
      FROM public.merchandise_recovery_plans p
      LEFT JOIN sale_term st ON st.sale_id = p.sale_id
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