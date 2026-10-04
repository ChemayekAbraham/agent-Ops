CREATE OR REPLACE FUNCTION public.get_coo_overview_snapshot(p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days int := GREATEST(3, LEAST(COALESCE(p_days, 14), 60));
  v_uid uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid, 'manager') OR has_role(v_uid, 'coo') OR has_role(v_uid, 'ceo')
       OR has_role(v_uid, 'cfo') OR has_role(v_uid, 'super_admin')
     ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH days AS (
    SELECT (d)::date AS day
    FROM generate_series(
      ((now() AT TIME ZONE 'Africa/Kampala')::date - (v_days - 1)),
      ((now() AT TIME ZONE 'Africa/Kampala')::date),
      interval '1 day'
    ) d
  ),
  agent_ids AS (
    SELECT DISTINCT agent_id AS id FROM rent_requests WHERE agent_id IS NOT NULL
    UNION
    SELECT DISTINCT assigned_agent_id FROM rent_requests WHERE assigned_agent_id IS NOT NULL
  ),
  landlord_ids AS (
    SELECT DISTINCT landlord_id AS id FROM landlord_payouts WHERE landlord_id IS NOT NULL
    UNION
    SELECT DISTINCT landlord_id FROM rent_requests
      WHERE landlord_id IS NOT NULL AND disbursed_at IS NOT NULL
  ),
  -- single source of truth for active repayment obligations
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
      (SELECT count(DISTINCT tenant_id) FROM rent_requests
         WHERE tenant_id IS NOT NULL)                                           AS tenants,
      (SELECT count(*) FROM landlord_ids)                                       AS landlords,
      (SELECT count(DISTINCT user_id) FROM user_roles
         WHERE role = 'employee' AND COALESCE(enabled, true))                   AS employees
  ),
  money AS (
    SELECT
      (SELECT COALESCE(sum(amount), 0) FROM landlord_payouts
         WHERE status IN ('completed', 'awaiting_agent_receipt'))               AS landlord_float_disbursed,
      (SELECT COALESCE(sum(amount), 0) FROM agent_collections)                  AS agent_collected_total,
      (SELECT COALESCE(sum(daily_repayment), 0) FROM live_rents)                AS expected_daily,
      (SELECT COALESCE(sum(GREATEST(total_repayment - COALESCE(amount_repaid, 0), 0)), 0)
         FROM rent_requests WHERE status IN ('funded', 'repaying'))             AS outstanding_expected,
      (SELECT COALESCE(sum(amount), 0) FROM general_ledger
         WHERE category = 'roi_wallet_credit')                                  AS partner_roi_paid,
      (SELECT COALESCE(sum(amount), 0) FROM general_ledger
         WHERE category = 'roi_reinvestment')                                   AS partner_compounded
  ),
  collections_by_day AS (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           COALESCE(sum(amount), 0) AS collected
    FROM agent_collections
    WHERE created_at >= ((now() AT TIME ZONE 'Africa/Kampala')::date - (v_days - 1))::timestamp
    GROUP BY 1
  ),
  booked_rents AS (
    SELECT COALESCE(total_repayment, 0) AS total_repayment,
           (COALESCE(disbursed_at, funded_at, created_at) AT TIME ZONE 'Africa/Kampala')::date AS start_day
    FROM rent_requests
    WHERE status IN ('funded', 'repaying', 'completed')
  ),
  expected_by_day AS (
    SELECT d.day,
           COALESCE((SELECT sum(lr.daily_repayment) FROM live_rents lr WHERE lr.start_day <= d.day), 0) AS expected
    FROM days d
  ),
  requested_by_day AS (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           COALESCE(sum(rent_amount), 0) AS requested
    FROM rent_requests
    WHERE created_at >= ((now() AT TIME ZONE 'Africa/Kampala')::date - (v_days - 1))::timestamp
    GROUP BY 1
  ),
  outstanding_by_day AS (
    SELECT d.day,
           GREATEST(
             COALESCE((SELECT sum(br.total_repayment) FROM booked_rents br WHERE br.start_day <= d.day), 0)
             - COALESCE((SELECT sum(ac.amount) FROM agent_collections ac
                          WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= d.day), 0),
             0) AS outstanding
    FROM days d
  ),
  collections_series AS (
    SELECT jsonb_agg(jsonb_build_object(
             'day', to_char(d.day, 'YYYY-MM-DD'),
             'label', to_char(d.day, 'DD Mon'),
             'collected', COALESCE(c.collected, 0),
             'expected', e.expected
           ) ORDER BY d.day) AS rows
    FROM days d
    LEFT JOIN collections_by_day c ON c.day = d.day
    JOIN expected_by_day e ON e.day = d.day
  ),
  pipeline_series AS (
    SELECT jsonb_agg(jsonb_build_object(
             'day', to_char(d.day, 'YYYY-MM-DD'),
             'label', to_char(d.day, 'DD Mon'),
             'requested', COALESCE(r.requested, 0),
             'repaying', COALESCE(c.collected, 0),
             'outstanding', o.outstanding
           ) ORDER BY d.day) AS rows
    FROM days d
    LEFT JOIN requested_by_day r ON r.day = d.day
    LEFT JOIN collections_by_day c ON c.day = d.day
    JOIN outstanding_by_day o ON o.day = d.day
  ),
  review_queue AS (
    SELECT rr.id, rr.rent_amount, rr.status, rr.created_at,
           rr.agent_id, rr.assigned_agent_id, rr.tenant_id
    FROM rent_requests rr
    WHERE rr.status IN ('landlord_ops_approved', 'tenant_ops_approved', 'agent_ops_approved',
                        'service_center_review', 'pending')
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
    'days', v_days,
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
$$;

REVOKE ALL ON FUNCTION public.get_coo_overview_snapshot(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_coo_overview_snapshot(integer) TO authenticated;