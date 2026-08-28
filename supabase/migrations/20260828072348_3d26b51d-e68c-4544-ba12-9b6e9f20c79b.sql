DO $mig$
DECLARE
  v_src text;
  v_old text;
  v_new text;
  p text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE oid = 'public.get_agent_products_services_report(date,date)'::regprocedure;

  -- 1. prod CTE: expose issuance flag + real handover date
  v_old := '           ms.payment_status, ms.order_status, ms.payment_plan,
           ms.sale_date, ms.client_name, ms.client_phone, ms.customer_id,';
  v_new := '           ms.payment_status, ms.order_status, ms.payment_plan,
           (ms.order_status IN (''approved'',''processing'',''completed'',''disbursed'',''active'')
             OR ms.cfo_disbursed_at IS NOT NULL
             OR ms.lease_activated_at IS NOT NULL) AS is_issued,
           COALESCE(
             (ms.cfo_disbursed_at AT TIME ZONE ''Africa/Kampala'')::date,
             (ms.lease_activated_at AT TIME ZONE ''Africa/Kampala'')::date,
             (ms.access_accepted_at AT TIME ZONE ''Africa/Kampala'')::date
           ) AS issued_date,
           ms.sale_date, ms.client_name, ms.client_phone, ms.customer_id,';
  IF position(v_old in v_src) = 0 THEN RAISE EXCEPTION 'prod CTE anchor not found'; END IF;
  v_src := replace(v_src, v_old, v_new);

  -- 2. prod_rows CTE: correct labelling, drop rejected/failed/cancelled
  v_old := '  prod_rows AS (
    SELECT p.*,
           CASE WHEN p.value <= 0 THEN 0 ELSE round((p.paid / p.value) * 100) END AS repayment_rate,
           CASE WHEN p.outstanding <= 0 THEN ''cleared''
                WHEN p.paid > 0 THEN ''on_track''
                ELSE ''behind'' END AS repayment_position
    FROM prod p
    WHERE p.product IN (''bike'',''smartphone'')
  ),';
  v_new := '  prod_rows AS (
    SELECT p.*,
           CASE WHEN NOT p.is_issued THEN 0
                WHEN p.value <= 0 THEN 0
                ELSE round((p.paid / p.value) * 100) END AS repayment_rate,
           CASE WHEN NOT p.is_issued THEN ''pending_issue''
                WHEN p.outstanding <= 0 AND p.paid > 0 THEN ''cleared''
                WHEN p.paid > 0 THEN ''on_track''
                ELSE ''behind'' END AS repayment_position
    FROM prod p
    WHERE p.product IN (''bike'',''smartphone'')
      AND COALESCE(p.order_status,'''') NOT IN (''rejected'',''failed'',''cancelled'')
  ),';
  IF position(v_old in v_src) = 0 THEN RAISE EXCEPTION 'prod_rows anchor not found'; END IF;
  v_src := replace(v_src, v_old, v_new);

  -- 3. bikes / phones aggregates: count only issued units
  FOREACH p IN ARRAY ARRAY['bike','smartphone'] LOOP
    v_old := '        ''issued_today'', count(*) FILTER (WHERE sale_date >= v_from AND sale_date <= v_day),
        ''issued_total'', count(*),
        ''total_value'', COALESCE(sum(value),0),
        ''paid'', COALESCE(sum(paid),0),
        ''outstanding'', COALESCE(sum(outstanding),0),
        ''daily_receivable'', COALESCE(sum(daily_rate) FILTER (WHERE outstanding > 0),0)
      ) FROM prod_rows WHERE product = ''' || p || ''')';
    v_new := '        ''issued_today'', count(*) FILTER (WHERE is_issued AND COALESCE(issued_date, sale_date) >= v_from AND COALESCE(issued_date, sale_date) <= v_day),
        ''issued_total'', count(*) FILTER (WHERE is_issued),
        ''pending_total'', count(*) FILTER (WHERE NOT is_issued),
        ''total_value'', COALESCE(sum(value) FILTER (WHERE is_issued),0),
        ''paid'', COALESCE(sum(paid) FILTER (WHERE is_issued),0),
        ''outstanding'', COALESCE(sum(outstanding) FILTER (WHERE is_issued),0),
        ''daily_receivable'', COALESCE(sum(daily_rate) FILTER (WHERE is_issued AND outstanding > 0),0)
      ) FROM prod_rows WHERE product = ''' || p || ''')';
    IF position(v_old in v_src) = 0 THEN RAISE EXCEPTION 'aggregate anchor not found for %', p; END IF;
    v_src := replace(v_src, v_old, v_new);
  END LOOP;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_agent_products_services_report(p_date date DEFAULT NULL::date, p_from date DEFAULT NULL::date)
     RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
     SET search_path = public SET statement_timeout = ''120s''
     AS %L', v_src);
END $mig$;