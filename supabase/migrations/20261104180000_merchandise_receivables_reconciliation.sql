-- 2026-11-04: merchandise receivables - the CMO dashboard and the Agent Products & Services page reconcile to the balance
-- sheet (A12 + A13). Read-only reporting: no ledger posting, wallet, payment, order or plan change.
--   1. get_merchandise_receivables_reconciliation(p_with_balance_sheet): every issued order (issued / approved / completed)
--      with its plan balance (what the agent still owes, future monthly charges included) and the receivable the ledger
--      carries for it (principal, A12 / A13); plans with a ledger receivable but no order; orders awaiting issue (not a
--      receivable); and, on request, the tie to A12 + A13 on the Statement of Financial Position. Read-only check
--      against production 2026-11-04: 63 issued orders 12,175,165.44 + 2 plans with no order 108,700 = A12 + A13
--      12,283,865.44, difference 0.
--   2. get_agent_products_overview (production definition, md5 48c04e6e74f9e66bc5e60061ffab38df, verbatim except):
--      cancelled plans no longer counted (they doubled 11 boutique orders, 980,000), and each agent row and the KPIs
--      carry ledger_receivable / in_field_ledger_receivable (the balance-sheet figure).
-- Rollback: supabase/rollbacks/20261104180000_merchandise_receivables_reconciliation.rollback.sql.
-- Tests: src/test/merchandiseReceivablesReconciliation.test.ts.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_agent_products_overview(text)'))
       IS DISTINCT FROM '48c04e6e74f9e66bc5e60061ffab38df'
     OR to_regprocedure('public._merch_receivable_net(uuid, uuid[], boolean)') IS NULL
     OR to_regclass('public.merchandise_stock_recognitions') IS NULL THEN
    RAISE EXCEPTION 'merchandise receivables reconciliation: production definitions differ - re-read before applying';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.get_agent_products_overview(p_category text DEFAULT NULL::text)
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
  v_pending jsonb;
  v_breakdown jsonb;
  v_activity jsonb;
  v_cat text := lower(coalesce(p_category, ''));
  v_is_boutique boolean := v_cat = 'boutique';
  v_pending_statuses text[] := CASE WHEN v_is_boutique THEN ARRAY['pending_approval','submitted','processing'] ELSE ARRAY['pending_approval','submitted'] END;
  -- 'approved' counts as issued: an approved order has left the queue, so it
  -- must appear in the field rather than vanishing between the two tabs.
  v_issued_statuses text[] := CASE WHEN v_is_boutique THEN ARRAY['issued','approved','completed'] ELSE NULL END;
  v_excluded text[] := ARRAY['pending_approval','submitted','rejected','cancelled','declined','ops_approved','coo_approved'];
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to view agent products';
  END IF;

  WITH field_sales AS (
    -- No user_roles gate here. Requiring a role row silently dropped approved
    -- sales whose buyer was never given one, which read as lost merchandise.
    -- COALESCE(customer_id, id) keeps such a sale as its own row instead.
    SELECT s.id,
           s.customer_id,
           COALESCE(s.customer_id, s.id) AS agent_key,
           s.client_name, s.client_phone,
           s.item_name, s.quantity, s.total_revenue,
           s.amount_paid, s.amount_outstanding, s.sale_date, s.payment_plan,
           s.service_centre_id, s.created_at,
           -- 2026-11-04: what the ledger carries for the order (A12 / A13, the balance sheet), principal only
           (SELECT (n->>'a12')::numeric + (n->>'a13')::numeric
              FROM public._merch_receivable_net(s.id,
                     (SELECT COALESCE(array_agg(p.id), '{}') FROM public.merchandise_recovery_plans p WHERE p.sale_id = s.id),
                     public.agent_product_category(s.item_name) = 'motor_bike') n) AS ledger_receivable
    FROM public.merchandise_sales s
    WHERE public.agent_product_category(s.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(s.item_name))
      AND (
        (v_is_boutique AND lower(COALESCE(s.order_status,'issued')) = ANY(v_issued_statuses))
        OR
        (NOT v_is_boutique AND lower(COALESCE(s.order_status,'issued')) <> ALL (v_excluded))
      )
      AND (
        v_is_boutique
        OR EXISTS (
          SELECT 1 FROM public.user_roles ur
          WHERE ur.user_id = s.customer_id
            AND ur.role IN ('agent','senior_agent','sub_agent')
        )
      )
  ),
  plan_agg AS (
    SELECT p.sale_id,
           SUM(COALESCE(p.amount_recovered,0)) AS recovered,
           SUM(COALESCE(p.outstanding_balance,0)) AS outstanding
    FROM public.merchandise_recovery_plans p
    WHERE p.sale_id IS NOT NULL
      -- 2026-11-04: a cancelled plan was replaced by a new one; counting both doubled the order
      AND p.status <> 'cancelled'
    GROUP BY p.sale_id
  ),
  per_agent AS (
    SELECT f.agent_key AS agent_id,
           COALESCE(MAX(pr.full_name), MAX(f.client_name)) AS full_name,
           MAX(pr.avatar_url) AS avatar_url,
           COALESCE(MAX(pr.phone), MAX(f.client_phone)) AS phone,
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
           SUM(COALESCE(f.ledger_receivable, 0)) AS ledger_receivable,
           MAX(COALESCE(f.sale_date, f.created_at::date)) AS last_issued_on,
           jsonb_agg(DISTINCT f.item_name) AS product_names
    FROM field_sales f
    LEFT JOIN plan_agg pa ON pa.sale_id = f.id
    LEFT JOIN public.profiles pr ON pr.id = f.customer_id
    LEFT JOIN public.service_centre_setups sc ON sc.id = f.service_centre_id
    LEFT JOIN public.service_centre_setups sc2 ON sc2.agent_id = f.customer_id
    GROUP BY f.agent_key
  ),
  cat_sales AS (
    SELECT s.quantity, s.item_name
    FROM public.merchandise_sales s
    WHERE public.agent_product_category(s.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(s.item_name))
      AND (
        (v_is_boutique AND lower(COALESCE(s.order_status,'issued')) = ANY(v_issued_statuses))
        OR
        (NOT v_is_boutique AND lower(COALESCE(s.order_status,'issued')) <> ALL (v_excluded))
      )
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
  ),
  pending_apps AS (
    SELECT COUNT(*) AS cnt
    FROM public.merchandise_sales s
    WHERE public.agent_product_category(s.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(s.item_name))
      AND lower(COALESCE(s.order_status,'issued')) = ANY(v_pending_statuses)
      AND (
        v_is_boutique
        OR EXISTS (
          SELECT 1 FROM public.user_roles ur
          WHERE ur.user_id = s.customer_id
            AND ur.role IN ('agent','senior_agent','sub_agent')
        )
      )
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
      'in_field_ledger_receivable', COALESCE((SELECT SUM(ledger_receivable) FROM per_agent), 0),
      'in_field_repaid', COALESCE((SELECT SUM(repaid_amount) FROM per_agent), 0),
      'in_field_repayable', COALESCE((SELECT SUM(repaid_amount + outstanding_amount) FROM per_agent), 0),
      'in_field_fully_paid', COALESCE((SELECT COUNT(*) FROM per_agent WHERE repaid_amount > 0 AND outstanding_amount <= 0), 0),
      'purchased_qty', (SELECT purchased_qty FROM stock),
      'purchased_value', (SELECT purchased_value FROM stock),
      'stock_qty', GREATEST((SELECT purchased_qty - sold_qty FROM stock), 0),
      'service_centres', COALESCE((SELECT COUNT(DISTINCT location_name) FROM per_agent WHERE location_name IS NOT NULL), 0),
      'pending_applications', COALESCE((SELECT cnt FROM pending_apps), 0)
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

  -- Pending applications (quick-action queue)
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'created_at') DESC), '[]'::jsonb)
  INTO v_pending
  FROM (
    SELECT jsonb_build_object(
             'sale_id', s.id,
             'agent_id', s.customer_id,
             'full_name', COALESCE(pr.full_name, s.client_name),
             'avatar_url', pr.avatar_url,
             'phone', COALESCE(pr.phone, s.client_phone),
             'item_name', s.item_name,
             'brand', s.brand,
             'model_type', s.model_type,
             'quantity', COALESCE(s.quantity, 1),
             'requested_amount', COALESCE(NULLIF(s.total_amount,0), s.total_revenue, 0),
             'order_status', lower(COALESCE(s.order_status,'pending_approval')),
             'created_at', s.created_at
           ) AS x
    FROM public.merchandise_sales s
    LEFT JOIN public.profiles pr ON pr.id = s.customer_id
    WHERE public.agent_product_category(s.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(s.item_name))
      AND lower(COALESCE(s.order_status,'issued')) = ANY(v_pending_statuses)
    ORDER BY s.created_at DESC
    LIMIT 25
  ) q;

  -- Catalog / brand inventory breakdown
  IF v_cat = 'smart_phone' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'label')), '[]'::jsonb)
    INTO v_breakdown
    FROM (
      SELECT jsonb_build_object(
               'label', b.label,
               'models', b.models,
               'reference_price', b.reference_price,
               'issued_qty', COALESCE(m.qty, 0),
               'issued_value', COALESCE(m.value, 0),
               'outstanding', COALESCE(m.outstanding, 0)
             ) AS x
      FROM (
        SELECT COALESCE(NULLIF(btrim(c.brand),''), 'Unbranded') AS label,
               COUNT(DISTINCT c.id) AS models,
               ROUND(AVG(COALESCE(c.default_amount,0))) AS reference_price
        FROM public.smartphone_catalog c
        WHERE c.is_active
        GROUP BY COALESCE(NULLIF(btrim(c.brand),''), 'Unbranded')
      ) b
      LEFT JOIN LATERAL (
        SELECT SUM(COALESCE(s.quantity,1)) AS qty,
               SUM(COALESCE(NULLIF(s.total_amount,0), s.total_revenue, 0)) AS value,
               SUM(COALESCE(s.amount_outstanding,0)) AS outstanding
        FROM public.merchandise_sales s
        WHERE lower(COALESCE(s.brand,'')) = lower(b.label)
          AND public.agent_product_category(s.item_name) = 'smart_phone'
          AND (
            (v_is_boutique AND lower(COALESCE(s.order_status,'issued')) = ANY(v_issued_statuses))
            OR
            (NOT v_is_boutique AND lower(COALESCE(s.order_status,'issued')) <> ALL (v_excluded))
          )
      ) m ON true
    ) q;
  ELSE
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'label')), '[]'::jsonb)
    INTO v_breakdown
    FROM (
      SELECT jsonb_build_object(
               'label', c.item_name,
               'models', 1,
               'reference_price', ROUND(COALESCE(c.unit_price,0)),
               'issued_qty', COALESCE(m.qty, 0),
               'issued_value', COALESCE(m.value, 0),
               'outstanding', COALESCE(m.outstanding, 0)
             ) AS x
      FROM public.merchandise_catalog c
      LEFT JOIN LATERAL (
        SELECT SUM(COALESCE(s.quantity,1)) AS qty,
               SUM(COALESCE(NULLIF(s.total_amount,0), s.total_revenue, 0)) AS value,
               SUM(COALESCE(s.amount_outstanding,0)) AS outstanding
        FROM public.merchandise_sales s
        WHERE lower(s.item_name) = lower(c.item_name)
          AND (
            (v_is_boutique AND lower(COALESCE(s.order_status,'issued')) = ANY(v_issued_statuses))
            OR
            (NOT v_is_boutique AND lower(COALESCE(s.order_status,'issued')) <> ALL (v_excluded))
          )
      ) m ON true
      WHERE c.is_active
        AND public.agent_product_category(c.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(c.item_name))
    ) q;
  END IF;

  -- Recent field activity
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'happened_at') DESC), '[]'::jsonb)
  INTO v_activity
  FROM (
    SELECT jsonb_build_object(
             'sale_id', s.id,
             'agent_id', s.customer_id,
             'full_name', COALESCE(pr.full_name, s.client_name),
             'avatar_url', pr.avatar_url,
             'item_name', s.item_name,
             'brand', s.brand,
             'model_type', s.model_type,
             'amount', COALESCE(NULLIF(s.total_amount,0), s.total_revenue, 0),
             'outstanding', COALESCE(s.amount_outstanding, 0),
             'order_status', lower(COALESCE(s.order_status,'issued')),
             'happened_at', COALESCE(s.updated_at, s.created_at)
           ) AS x
    FROM public.merchandise_sales s
    LEFT JOIN public.profiles pr ON pr.id = s.customer_id
    WHERE public.agent_product_category(s.item_name) = COALESCE(NULLIF(v_cat,''), public.agent_product_category(s.item_name))
      AND lower(COALESCE(s.order_status,'issued')) <> ALL(ARRAY['rejected','cancelled','declined'])
      AND (NOT v_is_boutique OR lower(COALESCE(s.order_status,'issued')) NOT IN ('pending_approval','submitted','processing'))
    ORDER BY COALESCE(s.updated_at, s.created_at) DESC
    LIMIT 12
  ) q;

  RETURN jsonb_build_object(
    'kpis', v_kpis,
    'rows', v_rows,
    'catalog', v_catalog,
    'centres', v_centres,
    'pending', v_pending,
    'breakdown', v_breakdown,
    'activity', v_activity
  );
END;
$function$;

-- One reconciliation both pages read: every issued order with its plan balance (what the agent still owes, future monthly
-- charges included) and what the ledger carries for it (A12 / A13, principal only, the balance sheet), plans with no
-- order, orders awaiting issue (not a receivable), and - with p_with_balance_sheet - the tie to A12 + A13 on the
-- Statement of Financial Position (sofp_ledger_legs; slow, so the pages load it separately).
CREATE OR REPLACE FUNCTION public.get_merchandise_receivables_reconciliation(p_with_balance_sheet boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE v_orders jsonb; v_orphans jsonb; v_awaiting jsonb; v_t jsonb; v_bs jsonb; v_a12 numeric; v_a13 numeric; v_led numeric;
BEGIN
  IF NOT public._agent_products_authorized() THEN
    RAISE EXCEPTION 'Not authorized to view merchandise receivables';
  END IF;

  WITH o AS (
    SELECT s.id, s.item_name, s.customer_id, s.client_name, s.client_phone, s.quantity, s.total_revenue, s.amount_paid,
           s.amount_outstanding, s.disbursed_amount, COALESCE(s.sale_date, s.created_at::date) AS sale_date,
           lower(COALESCE(s.order_status, 'issued')) AS st, public.agent_product_category(s.item_name) AS cat,
           (SELECT COALESCE(array_agg(p.id), '{}') FROM public.merchandise_recovery_plans p WHERE p.sale_id = s.id) AS plans
    FROM public.merchandise_sales s
  ), x AS (
    SELECT o.*, o.st IN ('issued', 'approved', 'completed') AS issued,
           public._merch_receivable_net(o.id, o.plans, o.cat = 'motor_bike') AS net,
           (SELECT sum(p.outstanding_balance) FROM public.merchandise_recovery_plans p
             WHERE p.sale_id = o.id AND p.status <> 'cancelled') AS plan_bal,
           (SELECT r.amount FROM public.merchandise_stock_recognitions r WHERE r.sale_id = o.id AND r.status = 'pending') AS awaiting_recognition,
           pr.full_name, pr.phone
    FROM o LEFT JOIN public.profiles pr ON pr.id = o.customer_id
  ), y AS (
    SELECT x.*, (x.net->>'a12')::numeric + (x.net->>'a13')::numeric AS ledger,
           COALESCE(x.plan_bal, x.amount_outstanding, 0) AS plan_balance
    FROM x
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'sale_id', y.id, 'item_name', y.item_name, 'category', y.cat, 'order_status', y.st, 'issued', y.issued,
      'customer_id', y.customer_id, 'customer', COALESCE(y.full_name, y.client_name), 'phone', COALESCE(y.phone, y.client_phone),
      'quantity', y.quantity, 'price', y.total_revenue, 'paid', y.amount_paid, 'sale_date', y.sale_date,
      'account', CASE WHEN y.cat = 'motor_bike' THEN 'A13' ELSE 'A12' END,
      'ledger_receivable', y.ledger, 'plan_balance', y.plan_balance,
      'not_in_ledger', CASE WHEN y.issued THEN y.plan_balance - y.ledger ELSE 0 END,
      'awaiting_recognition', COALESCE(y.awaiting_recognition, 0),
      'no_customer_account', y.customer_id IS NULL,
      'note', CASE
        WHEN NOT y.issued THEN 'not_issued_ledger_balance'
        WHEN COALESCE(y.awaiting_recognition, 0) > 0 THEN 'awaiting_recognition'
        WHEN y.cat = 'motor_bike' AND y.disbursed_amount IS NOT NULL AND y.disbursed_amount <> y.total_revenue THEN 'bike_paid_differs_from_value'
        WHEN y.plan_balance - y.ledger > 0.005 THEN 'future_charges'
        WHEN y.plan_balance - y.ledger < -0.005 THEN 'ledger_above_plan'
        ELSE NULL END
    ) ORDER BY y.sale_date DESC, y.id) FILTER (WHERE y.issued OR y.ledger <> 0), '[]'::jsonb),
    jsonb_build_object(
      'count', count(*) FILTER (WHERE NOT y.issued AND y.st NOT IN ('rejected', 'failed', 'cancelled', 'declined', 'deleted')),
      'value', COALESCE(sum(y.total_revenue) FILTER (WHERE NOT y.issued AND y.st NOT IN ('rejected', 'failed', 'cancelled', 'declined', 'deleted')), 0))
  INTO v_orders, v_awaiting
  FROM y;

  -- plans that carry a receivable in the ledger but have no order (invisible on the order pages)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'plan_id', z.id, 'item_name', z.item_name, 'customer_id', z.customer_id, 'customer', z.full_name,
           'status', z.status, 'plan_balance', z.outstanding_balance, 'ledger_receivable', z.ledger,
           'account', CASE WHEN z.bike THEN 'A13' ELSE 'A12' END) ORDER BY z.created_at), '[]'::jsonb)
  INTO v_orphans
  FROM (
    SELECT p.id, p.item_name, p.customer_id, pr.full_name, p.status, p.outstanding_balance, p.created_at,
           COALESCE(p.is_bike_lease, false) AS bike,
           (SELECT (n->>'a12')::numeric + (n->>'a13')::numeric
              FROM public._merch_receivable_net(NULL, ARRAY[p.id], COALESCE(p.is_bike_lease, false)) n) AS ledger
    FROM public.merchandise_recovery_plans p
    LEFT JOIN public.profiles pr ON pr.id = p.customer_id
    WHERE p.sale_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.merchandise_sales s WHERE s.id = p.sale_id)
  ) z
  WHERE z.ledger <> 0;

  SELECT jsonb_build_object(
    'issued_orders', count(*) FILTER (WHERE (e->>'issued')::boolean),
    'issued_value', COALESCE(sum((e->>'price')::numeric) FILTER (WHERE (e->>'issued')::boolean), 0),
    'plan_balance_issued', COALESCE(sum((e->>'plan_balance')::numeric) FILTER (WHERE (e->>'issued')::boolean), 0),
    'ledger_issued', COALESCE(sum((e->>'ledger_receivable')::numeric) FILTER (WHERE (e->>'issued')::boolean), 0),
    'awaiting_recognition', COALESCE(sum((e->>'awaiting_recognition')::numeric) FILTER (WHERE (e->>'issued')::boolean), 0),
    'not_in_ledger_other', COALESCE(sum((e->>'not_in_ledger')::numeric - (e->>'awaiting_recognition')::numeric)
                                      FILTER (WHERE (e->>'issued')::boolean), 0),
    'ledger_not_issued', COALESCE(sum((e->>'ledger_receivable')::numeric) FILTER (WHERE NOT (e->>'issued')::boolean), 0),
    'ledger_orphan_plans', COALESCE((SELECT sum((p->>'ledger_receivable')::numeric) FROM jsonb_array_elements(v_orphans) p), 0))
  INTO v_t
  FROM jsonb_array_elements(v_orders) e;
  v_led := (v_t->>'ledger_issued')::numeric + (v_t->>'ledger_not_issued')::numeric + (v_t->>'ledger_orphan_plans')::numeric;
  v_t := v_t || jsonb_build_object('ledger_total', v_led);

  IF p_with_balance_sheet THEN
    SELECT COALESCE(sum(dr - cr) FILTER (WHERE account_code = 'A12'), 0), COALESCE(sum(dr - cr) FILTER (WHERE account_code = 'A13'), 0)
      INTO v_a12, v_a13
    FROM public.sofp_ledger_legs(now()) WHERE account_code IN ('A12', 'A13');
    v_bs := jsonb_build_object('a12', v_a12, 'a13', v_a13, 'total', v_a12 + v_a13, 'difference', v_a12 + v_a13 - v_led);
  END IF;

  RETURN jsonb_build_object('as_at', now(), 'orders', v_orders, 'orphan_plans', v_orphans, 'awaiting_issue', v_awaiting,
                            'totals', v_t, 'balance_sheet', v_bs);
END $function$;

REVOKE ALL ON FUNCTION public.get_merchandise_receivables_reconciliation(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_merchandise_receivables_reconciliation(boolean) TO authenticated;
