DROP FUNCTION IF EXISTS public.get_coo_overview_snapshot(integer);

CREATE OR REPLACE FUNCTION public.get_coo_overview_snapshot(
  p_days integer DEFAULT 14,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_days int := GREATEST(3, LEAST(COALESCE(p_days, 14), 60));
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from date;
  v_to date;
  v_start timestamptz;
  v_end timestamptz;
  v_span int;
  v_monthly boolean;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid, 'manager') OR has_role(v_uid, 'coo') OR has_role(v_uid, 'ceo')
       OR has_role(v_uid, 'cfo') OR has_role(v_uid, 'super_admin')
     ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  -- Window resolution: explicit range wins, else trailing p_days window.
  v_to := LEAST(COALESCE(p_to, v_today), v_today);
  v_from := COALESCE(p_from, v_to - (v_days - 1));
  IF v_from > v_to THEN v_from := v_to; END IF;

  v_start := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_span := (v_to - v_from) + 1;
  v_monthly := v_span > 62;

  WITH buckets AS (
    SELECT b::date AS bucket_start,
           LEAST(
             CASE WHEN v_monthly THEN (b + interval '1 month' - interval '1 day')::date ELSE b::date END,
             v_to
           ) AS bucket_end
    FROM generate_series(
      CASE WHEN v_monthly THEN date_trunc('month', v_from::timestamp)::date ELSE v_from END,
      v_to,
      CASE WHEN v_monthly THEN interval '1 month' ELSE interval '1 day' END
    ) b
  ),
  -- Network definitions -------------------------------------------------
  tenant_ids AS (
    SELECT DISTINCT tenant_id AS id FROM agent_collections WHERE tenant_id IS NOT NULL
    UNION
    SELECT DISTINCT tenant_id FROM rent_requests
      WHERE tenant_id IS NOT NULL AND COALESCE(amount_repaid, 0) > 0
  ),
  agent_ids AS (
    SELECT DISTINCT agent_id AS id FROM agent_collections WHERE agent_id IS NOT NULL
    UNION
    SELECT DISTINCT agent_id FROM landlord_payouts WHERE agent_id IS NOT NULL
  ),
  landlord_ids AS (
    SELECT DISTINCT landlord_id AS id FROM landlord_payouts
      WHERE landlord_id IS NOT NULL
        AND (disbursed_at IS NOT NULL OR status IN ('completed', 'awaiting_agent_receipt'))
    UNION
    SELECT DISTINCT landlord_id FROM rent_requests
      WHERE landlord_id IS NOT NULL AND disbursed_at IS NOT NULL
  ),
  live_rents AS (
    SELECT COALESCE(daily_repayment, 0) AS daily_repayment,
           (start_at AT TIME ZONE 'Africa/Kampala')::date AS start_day
    FROM v_tenant_daily_eligibility
  ),
  counts AS (
    SELECT
      (SELECT count(*) FROM agent_ids)                                          AS agents,
      (SELECT count(DISTINCT investor_id) FROM investor_portfolios
         WHERE investor_id IS NOT NULL)                                         AS partners,
      (SELECT count(*) FROM tenant_ids)                                         AS tenants,
      (SELECT count(*) FROM landlord_ids)                                       AS landlords,
      (SELECT count(DISTINCT user_id) FROM user_roles
         WHERE role = 'employee' AND COALESCE(enabled, true))                   AS employees
  ),
  money AS (
    SELECT
      (SELECT COALESCE(sum(amount), 0) FROM landlord_payouts
         WHERE status IN ('completed', 'awaiting_agent_receipt')
           AND COALESCE(disbursed_at, created_at) >= v_start
           AND COALESCE(disbursed_at, created_at) < v_end)                      AS landlord_float_disbursed,
      (SELECT COALESCE(sum(amount), 0) FROM agent_collections
         WHERE created_at >= v_start AND created_at < v_end)                    AS agent_collected_total,
      (SELECT COALESCE(sum(daily_repayment), 0) FROM live_rents)                AS expected_daily,
      (SELECT COALESCE(sum(GREATEST(total_repayment - COALESCE(amount_repaid, 0), 0)), 0)
         FROM rent_requests WHERE status IN ('funded', 'repaying'))             AS outstanding_expected,
      (SELECT COALESCE(sum(amount), 0) FROM general_ledger
         WHERE category = 'roi_wallet_credit'
           AND transaction_date >= v_start AND transaction_date < v_end)        AS partner_roi_paid,
      (SELECT COALESCE(sum(amount), 0) FROM general_ledger
         WHERE category = 'roi_reinvestment'
           AND transaction_date >= v_start AND transaction_date < v_end)        AS partner_compounded
  ),
  collections_raw AS (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS day, amount
    FROM agent_collections
    WHERE created_at >= v_start AND created_at < v_end
  ),
  requested_raw AS (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS day, COALESCE(rent_amount, 0) AS rent_amount
    FROM rent_requests
    WHERE created_at >= v_start AND created_at < v_end
  ),
  booked_rents AS (
    SELECT COALESCE(total_repayment, 0) AS total_repayment,
           (COALESCE(disbursed_at, funded_at, created_at) AT TIME ZONE 'Africa/Kampala')::date AS start_day
    FROM rent_requests
    WHERE status IN ('funded', 'repaying', 'completed')
  ),
  all_collections AS (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS day, amount FROM agent_collections
  ),
  bucket_rows AS (
    SELECT
      b.bucket_start,
      b.bucket_end,
      CASE WHEN v_monthly THEN to_char(b.bucket_start, 'Mon YY') ELSE to_char(b.bucket_start, 'DD Mon') END AS label,
      COALESCE((SELECT sum(c.amount) FROM collections_raw c
                 WHERE c.day BETWEEN b.bucket_start AND b.bucket_end), 0) AS collected,
      COALESCE((SELECT sum(r.rent_amount) FROM requested_raw r
                 WHERE r.day BETWEEN b.bucket_start AND b.bucket_end), 0) AS requested,
      COALESCE((SELECT sum(lr.daily_repayment) FROM live_rents lr
                 WHERE lr.start_day <= b.bucket_end), 0) AS expected,
      GREATEST(
        COALESCE((SELECT sum(br.total_repayment) FROM booked_rents br
                   WHERE br.start_day <= b.bucket_end), 0)
        - COALESCE((SELECT sum(ac.amount) FROM all_collections ac
                     WHERE ac.day <= b.bucket_end), 0),
        0) AS outstanding
    FROM buckets b
  ),
  collections_series AS (
    SELECT jsonb_agg(jsonb_build_object(
             'day', to_char(bucket_start, 'YYYY-MM-DD'),
             'label', label,
             'collected', collected,
             'expected', expected
           ) ORDER BY bucket_start) AS rows
    FROM bucket_rows
  ),
  pipeline_series AS (
    SELECT jsonb_agg(jsonb_build_object(
             'day', to_char(bucket_start, 'YYYY-MM-DD'),
             'label', label,
             'requested', requested,
             'repaying', collected,
             'outstanding', outstanding
           ) ORDER BY bucket_start) AS rows
    FROM bucket_rows
  ),
  review_queue AS (
    SELECT rr.id, rr.rent_amount, rr.status, rr.created_at,
           rr.agent_id, rr.assigned_agent_id, rr.tenant_id
    FROM rent_requests rr
    WHERE rr.status = 'landlord_ops_approved'
      AND rr.created_at >= v_start AND rr.created_at < v_end
    ORDER BY rr.created_at DESC
    LIMIT 6
  ),
  review_rows AS (
    SELECT jsonb_agg(jsonb_build_object(
             'id', q.id,
             'rent_amount', COALESCE(q.rent_amount, 0),
             'status', q.status,
             'created_at', q.created_at,
             'agent_name', ap.full_name,
             'agent_avatar_url', ap.avatar_url,
             'tenant_name', tp.full_name
           ) ORDER BY q.created_at DESC) AS rows
    FROM review_queue q
    LEFT JOIN profiles ap ON ap.id = COALESCE(q.agent_id, q.assigned_agent_id)
    LEFT JOIN profiles tp ON tp.id = q.tenant_id
  ),
  roi_queue AS (
    SELECT p.id, p.amount, p.created_at,
           COALESCE(p.target_wallet_user_id, p.user_id) AS partner_id,
           p.description
    FROM pending_wallet_operations p
    WHERE p.category = 'roi_payout' AND p.status = 'pending_coo_approval'
      AND p.created_at >= v_start AND p.created_at < v_end
    ORDER BY p.created_at DESC
    LIMIT 5
  ),
  roi_rows AS (
    SELECT jsonb_agg(jsonb_build_object(
             'id', q.id,
             'amount', COALESCE(q.amount, 0),
             'created_at', q.created_at,
             'description', q.description,
             'partner_name', pp.full_name,
             'partner_avatar_url', pp.avatar_url
           ) ORDER BY q.created_at DESC) AS rows
    FROM roi_queue q
    LEFT JOIN profiles pp ON pp.id = q.partner_id
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'days', v_span,
    'range', jsonb_build_object(
      'from', to_char(v_from, 'YYYY-MM-DD'),
      'to', to_char(v_to, 'YYYY-MM-DD'),
      'bucket', CASE WHEN v_monthly THEN 'month' ELSE 'day' END
    ),
    'counts', to_jsonb(counts),
    'money', to_jsonb(money),
    'collections_series', COALESCE((SELECT rows FROM collections_series), '[]'::jsonb),
    'pipeline_series', COALESCE((SELECT rows FROM pipeline_series), '[]'::jsonb),
    'review_requests', COALESCE((SELECT rows FROM review_rows), '[]'::jsonb),
    'pending_roi', COALESCE((SELECT rows FROM roi_rows), '[]'::jsonb)
  )
  INTO v_result
  FROM counts, money;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_coo_overview_snapshot(integer, date, date) TO authenticated;

-- Rent coverage financial statement -------------------------------------
CREATE OR REPLACE FUNCTION public.get_coo_rent_coverage_statement()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid, 'manager') OR has_role(v_uid, 'coo') OR has_role(v_uid, 'ceo')
       OR has_role(v_uid, 'cfo') OR has_role(v_uid, 'super_admin')
       OR has_role(v_uid, 'financial_ops')
     ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH repaid_collections AS (
    SELECT tenant_id, rent_request_id, amount, created_at FROM agent_collections
  ),
  real_rents AS (
    SELECT rr.id, rr.tenant_id, rr.status,
           COALESCE(rr.rent_amount, 0)    AS rent_amount,
           COALESCE(rr.total_repayment, 0) AS total_repayment,
           COALESCE(rr.amount_repaid, 0)  AS amount_repaid
    FROM rent_requests rr
    WHERE rr.status IN ('repaying', 'funded', 'completed')
      AND (
        COALESCE(rr.amount_repaid, 0) > 0
        OR EXISTS (SELECT 1 FROM repaid_collections c WHERE c.rent_request_id = rr.id)
      )
  ),
  tenant_totals AS (
    SELECT
      count(DISTINCT tenant_id) FILTER (WHERE tenant_id IS NOT NULL)                              AS tenants_total,
      count(DISTINCT tenant_id) FILTER (WHERE status = 'repaying' AND tenant_id IS NOT NULL)      AS tenants_repaying,
      count(DISTINCT tenant_id) FILTER (WHERE status = 'funded' AND tenant_id IS NOT NULL)        AS tenants_funded,
      count(DISTINCT tenant_id) FILTER (WHERE status = 'completed' AND tenant_id IS NOT NULL)     AS tenants_completed,
      count(*)                                                                                    AS plans_total,
      count(*) FILTER (WHERE status = 'repaying')                                                 AS plans_repaying,
      count(*) FILTER (WHERE status = 'funded')                                                    AS plans_funded,
      count(*) FILTER (WHERE status = 'completed')                                                 AS plans_completed,
      COALESCE(sum(total_repayment), 0)                                                           AS total_repayment_booked,
      COALESCE(sum(amount_repaid), 0)                                                             AS total_repaid_recorded,
      COALESCE(sum(GREATEST(total_repayment - amount_repaid, 0)), 0)                              AS outstanding
    FROM real_rents
  ),
  disbursed AS (
    SELECT
      (SELECT COALESCE(sum(amount), 0) FROM landlord_payouts
         WHERE status IN ('completed', 'awaiting_agent_receipt'))                                  AS landlord_float_disbursed,
      (SELECT count(*) FROM landlord_payouts
         WHERE status IN ('completed', 'awaiting_agent_receipt'))                                   AS landlord_payout_count,
      (SELECT count(DISTINCT landlord_id) FROM landlord_payouts
         WHERE status IN ('completed', 'awaiting_agent_receipt'))                                   AS landlords_paid,
      (SELECT COALESCE(sum(COALESCE(rent_amount, 0)), 0) FROM rent_requests
         WHERE status IN ('repaying', 'funded', 'completed'))                                       AS rent_approved_total
  ),
  collected AS (
    SELECT
      COALESCE(sum(amount), 0)                     AS collected_total,
      count(*)                                     AS collection_count,
      min(created_at)                              AS first_collection_at,
      max(created_at)                              AS last_collection_at
    FROM repaid_collections
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'tenants', jsonb_build_object(
      'total', t.tenants_total,
      'repaying', t.tenants_repaying,
      'funded', t.tenants_funded,
      'completed', t.tenants_completed
    ),
    'plans', jsonb_build_object(
      'total', t.plans_total,
      'repaying', t.plans_repaying,
      'funded', t.plans_funded,
      'completed', t.plans_completed
    ),
    'money', jsonb_build_object(
      'rent_approved_total', d.rent_approved_total,
      'landlord_float_disbursed', d.landlord_float_disbursed,
      'landlord_payout_count', d.landlord_payout_count,
      'landlords_paid', d.landlords_paid,
      'total_repayment_booked', t.total_repayment_booked,
      'collected_total', c.collected_total,
      'collection_count', c.collection_count,
      'recorded_repaid', t.total_repaid_recorded,
      'outstanding', t.outstanding,
      'coverage_rate', CASE WHEN d.landlord_float_disbursed > 0
                            THEN round((c.collected_total / d.landlord_float_disbursed) * 100, 2)
                            ELSE 0 END,
      'first_collection_at', c.first_collection_at,
      'last_collection_at', c.last_collection_at
    )
  )
  INTO v_result
  FROM tenant_totals t, disbursed d, collected c;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_coo_rent_coverage_statement() TO authenticated;