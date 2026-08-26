-- ═══════════════════════════════════════════════════════════════════════════
-- ONE authoritative receivables definition.
-- Line-level source view + 3 reporting RPCs. No per-hook JS math.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.get_cfo_receivables_breakdown_forecast(timestamptz);
DROP FUNCTION IF EXISTS public.get_receivables_breakdown();
DROP FUNCTION IF EXISTS public.get_receivables_forecast(date, date);
DROP VIEW IF EXISTS public.v_receivables_lines;

CREATE VIEW public.v_receivables_lines AS
-- ── AGENT ───────────────────────────────────────────────────────────────────
SELECT 'agent'::text AS category_key, 'Agent Products & Services'::text AS category_label,
       'agent_advance'::text AS product_key, 'Agent Advances'::text AS product_label,
       'agent_advances'::text AS source_table, a.id AS item_id, a.agent_id AS counterparty_id,
       COALESCE(p.full_name, 'Unknown agent')::text AS counterparty_name,
       GREATEST(COALESCE(a.outstanding_balance,0),0)::numeric AS outstanding_amount,
       NULL::date AS due_date, 'projected'::text AS due_kind,
       COALESCE(NULLIF(a.daily_installment,0), NULLIF(a.installment_amount,0), 0)::numeric AS daily_amount,
       a.status::text, a.created_at
  FROM public.agent_advances a
  LEFT JOIN public.profiles p ON p.id = a.agent_id
 WHERE a.status IN ('active','overdue') AND COALESCE(a.outstanding_balance,0) > 0

UNION ALL
SELECT 'agent', 'Agent Products & Services',
       'agent_advance_access_fee', 'Agent Advance Access Fees',
       'agent_advances.access_fee', a.id, a.agent_id,
       COALESCE(p.full_name, 'Unknown agent'),
       GREATEST(COALESCE(a.access_fee,0) - COALESCE(a.access_fee_collected,0), 0),
       a.expires_at::date, 'scheduled', 0,
       COALESCE(a.access_fee_status, a.status)::text, a.created_at
  FROM public.agent_advances a
  LEFT JOIN public.profiles p ON p.id = a.agent_id
 WHERE a.status IN ('active','overdue')
   AND GREATEST(COALESCE(a.access_fee,0) - COALESCE(a.access_fee_collected,0), 0) > 0

UNION ALL
SELECT 'agent', 'Agent Products & Services',
       'credit_access_draw', 'Credit Access Draws', 'credit_access_draws',
       d.id, COALESCE(d.agent_id, d.user_id),
       COALESCE(p.full_name, 'Unknown borrower'),
       GREATEST(COALESCE(d.outstanding_balance,0),0),
       NULL::date, 'projected', COALESCE(NULLIF(d.daily_charge,0),0),
       d.status::text, d.created_at
  FROM public.credit_access_draws d
  LEFT JOIN public.profiles p ON p.id = COALESCE(d.agent_id, d.user_id)
 WHERE d.status IN ('active','overdue') AND COALESCE(d.outstanding_balance,0) > 0

UNION ALL
SELECT 'agent', 'Agent Products & Services',
       'merchandise_recovery', 'Merchandise & Smartphone Recovery', 'merchandise_recovery_plans',
       r.id, r.customer_id,
       COALESCE(NULLIF(r.customer_name,''), p.full_name, 'Unknown customer'),
       GREATEST(COALESCE(r.outstanding_balance,0),0),
       NULL::date, 'projected', COALESCE(NULLIF(r.daily_deduction_amount,0), NULLIF(r.daily_rate,0), 0),
       r.status::text, r.created_at
  FROM public.merchandise_recovery_plans r
  LEFT JOIN public.profiles p ON p.id = r.customer_id
 WHERE r.status = 'active' AND COALESCE(r.outstanding_balance,0) > 0

UNION ALL
SELECT 'agent', 'Agent Products & Services',
       'merchandise_credit_sale', 'Merchandise Credit Sales', 'merchandise_sales',
       s.id, s.customer_id,
       COALESCE(NULLIF(s.client_name,''), p.full_name, 'Unknown customer'),
       GREATEST(COALESCE(s.amount_outstanding,0),0),
       NULL::date, 'projected', COALESCE(NULLIF(s.access_daily_amount,0),0),
       s.payment_status::text, s.created_at
  FROM public.merchandise_sales s
  LEFT JOIN public.profiles p ON p.id = s.customer_id
 WHERE COALESCE(s.amount_outstanding,0) > 0
   AND COALESCE(s.payment_status,'') <> 'paid'
   AND NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans rp
                    WHERE rp.sale_id = s.id AND rp.status = 'active')

UNION ALL
SELECT 'agent', 'Agent Products & Services',
       'service_centre_advance', 'Service Centre Advances', 'service_centre_advances',
       sa.id, sa.agent_id,
       COALESCE(p.full_name, 'Unknown agent'),
       GREATEST(COALESCE(sa.principal_amount,0) - COALESCE(sa.amount_recovered,0), 0),
       NULL::date, 'projected', COALESCE(NULLIF(sa.daily_deduction,0),0),
       sa.status::text, sa.created_at
  FROM public.service_centre_advances sa
  LEFT JOIN public.profiles p ON p.id = sa.agent_id
 WHERE sa.status = 'active'
   AND GREATEST(COALESCE(sa.principal_amount,0) - COALESCE(sa.amount_recovered,0), 0) > 0

-- ── TENANT ──────────────────────────────────────────────────────────────────
UNION ALL
SELECT 'tenant', 'Tenant Products & Services',
       'rent_plan', 'Rent Access Plans', 'rent_requests',
       rr.id, rr.tenant_id,
       COALESCE(p.full_name, 'Unknown tenant'),
       GREATEST(COALESCE(NULLIF(rr.total_repayment,0),
                         COALESCE(rr.rent_amount,0) + COALESCE(rr.access_fee,0) + COALESCE(rr.request_fee,0))
                - COALESCE(rr.amount_repaid,0), 0),
       NULL::date, 'projected', COALESCE(NULLIF(rr.daily_repayment,0),0),
       rr.status::text, rr.created_at
  FROM public.rent_requests rr
  LEFT JOIN public.profiles p ON p.id = rr.tenant_id
 WHERE rr.status IN ('funded','disbursed','repaying')
   AND GREATEST(COALESCE(NULLIF(rr.total_repayment,0),
                         COALESCE(rr.rent_amount,0) + COALESCE(rr.access_fee,0) + COALESCE(rr.request_fee,0))
                - COALESCE(rr.amount_repaid,0), 0) > 0

UNION ALL
SELECT 'tenant', 'Tenant Products & Services',
       'tenant_service_charge', 'Tenant Service Charges', 'subscription_charges',
       sc.id, sc.tenant_id,
       COALESCE(p.full_name, 'Unknown tenant'),
       GREATEST(COALESCE(sc.accumulated_debt,0),0),
       sc.next_charge_date, 'scheduled', 0,
       sc.status::text, sc.created_at
  FROM public.subscription_charges sc
  LEFT JOIN public.profiles p ON p.id = sc.tenant_id
 WHERE sc.status = 'active' AND COALESCE(sc.accumulated_debt,0) > 0

UNION ALL
SELECT 'tenant', 'Tenant Products & Services',
       'business_advance', 'Business Advances', 'business_advances',
       ba.id, ba.tenant_id,
       COALESCE(p.full_name, NULLIF(ba.business_name,''), 'Unknown business'),
       GREATEST(COALESCE(ba.outstanding_balance,0),0),
       NULL::date, 'projected',
       ROUND(GREATEST(COALESCE(ba.outstanding_balance,0),0) * COALESCE(ba.daily_rate,0), 2),
       ba.status::text, ba.created_at
  FROM public.business_advances ba
  LEFT JOIN public.profiles p ON p.id = ba.tenant_id
 WHERE ba.status::text IN ('active','defaulted') AND COALESCE(ba.outstanding_balance,0) > 0

-- ── LANDLORD ────────────────────────────────────────────────────────────────
UNION ALL
SELECT 'landlord', 'Landlord Products & Services',
       'welile_homes', 'Welile Homes Subscriptions', 'welile_homes_subscriptions',
       w.id, w.landlord_id,
       COALESCE(NULLIF(w.landlord_name,''), p.full_name, 'Unknown landlord'),
       GREATEST(COALESCE(w.outstanding_balance,0),0),
       w.next_due_date, 'scheduled', 0,
       w.subscription_status::text, w.created_at
  FROM public.welile_homes_subscriptions w
  LEFT JOIN public.profiles p ON p.id = w.landlord_id
 WHERE COALESCE(w.outstanding_balance,0) > 0

UNION ALL
SELECT 'landlord', 'Landlord Products & Services',
       'landlord_float_receivable', 'Landlord Float Receivables', 'landlord_float_receivables',
       lfr.id, lfr.landlord_id,
       COALESCE(NULLIF(lfr.landlord_name,''), p.full_name, 'Unknown landlord'),
       GREATEST(COALESCE(lfr.amount,0),0),
       lfr.promised_deposit_date, 'scheduled', 0,
       lfr.status::text, lfr.created_at
  FROM public.landlord_float_receivables lfr
  LEFT JOIN public.profiles p ON p.id = lfr.landlord_id
 WHERE COALESCE(lfr.amount,0) > 0
   AND COALESCE(lfr.status,'') NOT IN ('settled','cancelled')

-- ── PARTNER ─────────────────────────────────────────────────────────────────
UNION ALL
SELECT 'partner', 'Partner Products & Services',
       'promissory_note', 'Promissory Notes', 'promissory_notes',
       n.id, COALESCE(n.partner_user_id, n.agent_id),
       COALESCE(NULLIF(n.partner_name,''), 'Unknown partner'),
       GREATEST(COALESCE(n.amount,0) - COALESCE(n.total_collected,0), 0),
       n.next_deduction_date, 'scheduled', 0,
       n.status::text, n.created_at
  FROM public.promissory_notes n
 WHERE n.status IN ('pending','activated')
   AND GREATEST(COALESCE(n.amount,0) - COALESCE(n.total_collected,0), 0) > 0

-- ── UNCLASSIFIED / OTHER ────────────────────────────────────────────────────
UNION ALL
SELECT 'other', 'Unclassified / Other',
       'field_collection_pending', 'Unconfirmed Field Collections', 'field_collections',
       fc.id, fc.agent_id,
       COALESCE(NULLIF(fc.tenant_name,''), p.full_name, 'Unknown agent'),
       GREATEST(COALESCE(fc.amount,0),0),
       fc.captured_at::date, 'scheduled', 0,
       fc.status::text, fc.created_at
  FROM public.field_collections fc
  LEFT JOIN public.profiles p ON p.id = fc.agent_id
 WHERE fc.status = 'pending' AND COALESCE(fc.amount,0) > 0;

COMMENT ON VIEW public.v_receivables_lines IS
  'Authoritative line-level receivables source. Every Total Receivables figure in the product must derive from this view via get_receivables_total/breakdown/forecast. Undisbursed items (credit draws and business advances awaiting CFO release) are excluded by design.';

-- ── Shared category frame (guarantees all 6 categories always appear) ───────
CREATE OR REPLACE FUNCTION public.receivables_category_frame()
RETURNS TABLE(category_key text, category_label text, sort_order int)
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT * FROM (VALUES
    ('agent','Agent Products & Services',1),
    ('landlord','Landlord Products & Services',2),
    ('partner','Partner Products & Services',3),
    ('tenant','Tenant Products & Services',4),
    ('rnd','R&D',5),
    ('other','Unclassified / Other',6)
  ) f(category_key, category_label, sort_order)
$$;

CREATE OR REPLACE FUNCTION public.receivables_guard()
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
    OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
    OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view receivables' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ── 1. Headline total (used by every legacy consumer) ───────────────────────
CREATE OR REPLACE FUNCTION public.get_receivables_total()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM receivables_guard();
  SELECT jsonb_build_object(
    'currency','UGX',
    'as_at', now(),
    'total', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM v_receivables_lines),0),
    'item_count', COALESCE((SELECT COUNT(*) FROM v_receivables_lines),0),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'key', f.category_key, 'label', f.category_label,
               'outstanding', ROUND(COALESCE(SUM(l.outstanding_amount),0),2),
               'item_count', COUNT(l.item_id)
             ) ORDER BY f.sort_order)
      FROM receivables_category_frame() f
      LEFT JOIN v_receivables_lines l ON l.category_key = f.category_key
      GROUP BY f.category_key, f.category_label, f.sort_order
    ), '[]'::jsonb),
    'source','v_receivables_lines'
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- ── 2. Category / product breakdown with drill-down + hard validation ──────
CREATE OR REPLACE FUNCTION public.get_receivables_breakdown()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total numeric := 0;
  v_cats jsonb := '[]'::jsonb;
  v_cat_total numeric := 0;
BEGIN
  PERFORM receivables_guard();

  SELECT COALESCE(ROUND(SUM(outstanding_amount),2),0) INTO v_total FROM v_receivables_lines;

  WITH ranked AS (
    SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l.product_key ORDER BY l.outstanding_amount DESC) AS rn
    FROM v_receivables_lines l
  ), products AS (
    SELECT category_key, product_key, product_label, source_table,
           ROUND(SUM(outstanding_amount),2) AS outstanding,
           COUNT(*) AS item_count,
           SUM(CASE WHEN due_kind = 'scheduled' THEN outstanding_amount ELSE 0 END) AS scheduled_amount,
           SUM(CASE WHEN due_kind = 'projected' THEN outstanding_amount ELSE 0 END) AS projected_amount,
           COALESCE(jsonb_agg(jsonb_build_object(
             'item_id', item_id, 'counterparty', counterparty_name,
             'amount', ROUND(outstanding_amount,2), 'due_date', due_date,
             'due_kind', due_kind, 'status', status, 'source', source_table
           ) ORDER BY outstanding_amount DESC) FILTER (WHERE rn <= 100), '[]'::jsonb) AS items
    FROM ranked
    GROUP BY category_key, product_key, product_label, source_table
  )
  SELECT jsonb_agg(jsonb_build_object(
           'key', f.category_key, 'label', f.category_label,
           'outstanding', ROUND(COALESCE(c.outstanding,0),2),
           'item_count', COALESCE(c.item_count,0),
           'products', COALESCE(c.products,'[]'::jsonb)
         ) ORDER BY f.sort_order),
         COALESCE(SUM(c.outstanding),0)
    INTO v_cats, v_cat_total
  FROM receivables_category_frame() f
  LEFT JOIN (
    SELECT category_key,
           SUM(outstanding) AS outstanding,
           SUM(item_count) AS item_count,
           jsonb_agg(jsonb_build_object(
             'key', product_key, 'label', product_label, 'source', source_table,
             'outstanding', outstanding, 'item_count', item_count,
             'scheduled_amount', ROUND(scheduled_amount,2),
             'projected_amount', ROUND(projected_amount,2),
             'items', items
           ) ORDER BY outstanding DESC) AS products
    FROM products GROUP BY category_key
  ) c ON c.category_key = f.category_key;

  RETURN jsonb_build_object(
    'currency','UGX', 'as_at', now(),
    'total', v_total,
    'categories', COALESCE(v_cats,'[]'::jsonb),
    'validation', jsonb_build_object(
      'categories_total', ROUND(v_cat_total,2),
      'authoritative_total', v_total,
      'difference', ROUND(v_cat_total - v_total, 2),
      'ties_out', abs(v_cat_total - v_total) < 0.01
    ),
    'source','v_receivables_lines'
  );
END;
$$;

-- ── 3. Forecast: confirmed calendar dates vs estimated daily recovery ──────
CREATE OR REPLACE FUNCTION public.get_receivables_forecast(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Nairobi')::date;
  v_from date := LEAST(p_from, p_to);
  v_to date := GREATEST(p_from, p_to);
  v_days jsonb := '[]'::jsonb;
  v_products jsonb := '[]'::jsonb;
  v_sched numeric := 0;
  v_proj numeric := 0;
  v_unsched numeric := 0;
  v_basis jsonb;
BEGIN
  PERFORM receivables_guard();
  IF v_to > v_from + 400 THEN v_to := v_from + 400; END IF;

  CREATE TEMP TABLE IF NOT EXISTS _rf_rows(
    d date, category_key text, category_label text,
    product_key text, product_label text, kind text, amount numeric
  ) ON COMMIT DROP;
  DELETE FROM _rf_rows;

  -- Scheduled: an exact contractual date exists. Anything already past due is
  -- surfaced on the first day of the window so it is never silently dropped.
  INSERT INTO _rf_rows
  SELECT GREATEST(l.due_date, v_from), l.category_key, l.category_label,
         l.product_key, l.product_label, 'scheduled', l.outstanding_amount
  FROM v_receivables_lines l
  WHERE l.due_kind = 'scheduled' AND l.due_date IS NOT NULL
    AND l.due_date <= v_to
    AND (l.due_date >= v_from OR v_from <= v_today);

  -- Projected: no contractual date, but a live daily deduction exists.
  INSERT INTO _rf_rows
  SELECT (v_today + g)::date, p.category_key, p.category_label,
         p.product_key, p.product_label, 'projected',
         CASE WHEN g = p.days - 1
              THEN p.outstanding_amount - p.daily_amount * (p.days - 1)
              ELSE p.daily_amount END
  FROM (
    SELECT l.*, LEAST(400, CEIL(l.outstanding_amount / l.daily_amount))::int AS days
    FROM v_receivables_lines l
    WHERE l.due_kind = 'projected' AND l.daily_amount > 0 AND l.outstanding_amount > 0
  ) p
  CROSS JOIN generate_series(0, 399) g
  WHERE g < p.days
    AND (v_today + g)::date BETWEEN v_from AND v_to;

  -- Neither a date nor a daily rate: reported separately, never as forecast.
  SELECT COALESCE(ROUND(SUM(outstanding_amount),2),0) INTO v_unsched
  FROM v_receivables_lines
  WHERE (due_kind = 'projected' AND COALESCE(daily_amount,0) <= 0)
     OR (due_kind = 'scheduled' AND due_date IS NULL);

  SELECT COALESCE(ROUND(SUM(amount) FILTER (WHERE kind='scheduled'),2),0),
         COALESCE(ROUND(SUM(amount) FILTER (WHERE kind='projected'),2),0)
    INTO v_sched, v_proj FROM _rf_rows;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'date')), '[]'::jsonb) INTO v_days
  FROM (
    SELECT jsonb_build_object(
             'date', d,
             'scheduled', ROUND(SUM(amount) FILTER (WHERE kind='scheduled'),2),
             'projected', ROUND(SUM(amount) FILTER (WHERE kind='projected'),2),
             'total', ROUND(SUM(amount),2)
           ) AS x
    FROM _rf_rows GROUP BY d
  ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'total')::numeric DESC), '[]'::jsonb) INTO v_products
  FROM (
    SELECT jsonb_build_object(
             'category_key', category_key, 'category_label', category_label,
             'product_key', product_key, 'product_label', product_label,
             'scheduled', ROUND(COALESCE(SUM(amount) FILTER (WHERE kind='scheduled'),0),2),
             'projected', ROUND(COALESCE(SUM(amount) FILTER (WHERE kind='projected'),0),2),
             'total', ROUND(SUM(amount),2)
           ) AS x
    FROM _rf_rows
    GROUP BY category_key, category_label, product_key, product_label
  ) s;

  -- Projection credibility, from real recovery history (receivable side only).
  SELECT jsonb_build_object(
    'lookback_days', 90,
    'agent_collections', jsonb_build_object(
      'sample_days', (SELECT COUNT(DISTINCT (created_at AT TIME ZONE 'Africa/Nairobi')::date)
                        FROM agent_collections WHERE created_at >= now() - interval '90 days'),
      'median_daily', COALESCE((SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY amt),2) FROM (
                        SELECT SUM(COALESCE(amount,0)) amt FROM agent_collections
                        WHERE created_at >= now() - interval '90 days'
                        GROUP BY (created_at AT TIME ZONE 'Africa/Nairobi')::date) q),0)),
    'business_advance_repayments', jsonb_build_object(
      'sample_days', (SELECT COUNT(DISTINCT (created_at AT TIME ZONE 'Africa/Nairobi')::date)
                        FROM business_advance_repayments WHERE created_at >= now() - interval '90 days'),
      'median_daily', COALESCE((SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY amt),2) FROM (
                        SELECT SUM(COALESCE(amount,0)) amt FROM business_advance_repayments
                        WHERE created_at >= now() - interval '90 days'
                        GROUP BY (created_at AT TIME ZONE 'Africa/Nairobi')::date) q),0)),
    'credit_draw_ledger', jsonb_build_object(
      'sample_days', (SELECT COUNT(DISTINCT date) FROM credit_draw_ledger
                        WHERE date >= v_today - 90),
      'median_daily', COALESCE((SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY amt),2) FROM (
                        SELECT SUM(COALESCE(amount_deducted,0)) amt FROM credit_draw_ledger
                        WHERE date >= v_today - 90 GROUP BY date) q),0))
  ) INTO v_basis;

  RETURN jsonb_build_object(
    'currency','UGX', 'today', v_today,
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'scheduled_total', v_sched,
    'projected_total', v_proj,
    'range_total', ROUND(v_sched + v_proj, 2),
    'unscheduled_outstanding', v_unsched,
    'days', v_days,
    'products', v_products,
    'projection_basis', v_basis,
    'source','v_receivables_lines'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_receivables_total() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_receivables_breakdown() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_receivables_forecast(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_receivables_total() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_receivables_breakdown() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_receivables_forecast(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receivables_category_frame() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receivables_guard() TO authenticated, service_role;