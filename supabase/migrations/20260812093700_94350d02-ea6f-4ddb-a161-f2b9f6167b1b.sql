CREATE OR REPLACE FUNCTION public.ops_tenant_ops_tool_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_res jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_day_start := (date_trunc('day', (now() AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
  v_day_end := v_day_start + interval '1 day';

  SELECT jsonb_build_object(
    'review_requests', (
      SELECT count(*) FROM rent_requests rr
      WHERE rr.status IN ('agent_ops_approved','agent_verified','tenant_ops_approved')
    ),
    'new_requests', (
      SELECT count(*) FROM rent_requests rr WHERE rr.status = 'pending'
    ),
    'service_center_review', (
      SELECT count(*) FROM rent_requests rr WHERE rr.status = 'service_center_review'
    ),
    'active_plans', (
      SELECT count(*) FROM rent_requests rr WHERE rr.status IN ('funded','disbursed','repaying')
    ),
    'payments_today', (
      SELECT count(*) FROM agent_collections ac
      WHERE ac.created_at >= v_day_start AND ac.created_at < v_day_end
    ),
    'collected_today', (
      SELECT COALESCE(sum(ac.amount), 0) FROM agent_collections ac
      WHERE ac.created_at >= v_day_start AND ac.created_at < v_day_end
    ),
    'expected_today', (
      SELECT COALESCE(sum(rr.daily_repayment), 0) FROM rent_requests rr
      WHERE rr.status IN ('funded','disbursed','repaying')
        AND rr.disbursed_at IS NOT NULL
        AND COALESCE(rr.amount_repaid,0) < COALESCE(rr.total_repayment,0)
    ),
    'tenants_paid_today', (
      SELECT count(DISTINCT ac.tenant_id) FROM agent_collections ac
      WHERE ac.created_at >= v_day_start AND ac.created_at < v_day_end
    ),
    'missed_days_tenants', (
      SELECT count(*) FROM (
        SELECT rr.tenant_id
        FROM rent_requests rr
        WHERE rr.status IN ('funded','disbursed','repaying')
          AND rr.disbursed_at IS NOT NULL
          AND COALESCE(rr.daily_repayment,0) > 0
          AND floor(
                (LEAST(COALESCE(rr.daily_repayment,0) * GREATEST(1, (date_part('day', now() - rr.disbursed_at))::int), COALESCE(rr.total_repayment,0))
                 - COALESCE(rr.amount_repaid,0)) / rr.daily_repayment
              ) >= 1
        GROUP BY rr.tenant_id
      ) t
    ),
    'critical_tenants', (
      SELECT count(*) FROM (
        SELECT rr.tenant_id
        FROM rent_requests rr
        WHERE rr.status IN ('funded','disbursed','repaying')
          AND rr.disbursed_at IS NOT NULL
          AND COALESCE(rr.daily_repayment,0) > 0
          AND floor(
                (LEAST(COALESCE(rr.daily_repayment,0) * GREATEST(1, (date_part('day', now() - rr.disbursed_at))::int), COALESCE(rr.total_repayment,0))
                 - COALESCE(rr.amount_repaid,0)) / rr.daily_repayment
              ) >= 5
        GROUP BY rr.tenant_id
      ) t
    ),
    'transfers_30d', (
      SELECT count(*) FROM tenant_transfers tt WHERE tt.created_at >= now() - interval '30 days'
    ),
    'approvals_today', (
      SELECT count(*) FROM rent_requests rr
      WHERE (rr.tenant_ops_reviewed_at >= v_day_start AND rr.tenant_ops_reviewed_at < v_day_end)
         OR (rr.agent_verified_at >= v_day_start AND rr.agent_verified_at < v_day_end)
         OR (rr.landlord_ops_reviewed_at >= v_day_start AND rr.landlord_ops_reviewed_at < v_day_end)
         OR (rr.coo_reviewed_at >= v_day_start AND rr.coo_reviewed_at < v_day_end)
         OR (rr.cfo_reviewed_at >= v_day_start AND rr.cfo_reviewed_at < v_day_end)
    ),
    'rejected_30d', (
      SELECT count(*) FROM rent_requests rr
      WHERE rr.status = 'rejected' AND COALESCE(rr.rejected_at, rr.updated_at) >= now() - interval '30 days'
    ),
    'generated_at', to_jsonb(now())
  ) INTO v_res;

  RETURN v_res;
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_tenant_ops_tool_counts() FROM public;
GRANT EXECUTE ON FUNCTION public.ops_tenant_ops_tool_counts() TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.ops_tenant_ops_tool_report(
  p_tool text,
  p_status text DEFAULT 'all',
  p_search text DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 5000
)
RETURNS TABLE(row_data jsonb, total_count bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tool text := lower(coalesce(p_tool, ''));
  v_status text := lower(coalesce(nullif(btrim(coalesce(p_status,'')), ''), 'all'));
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
  v_limit int := least(greatest(coalesce(p_limit, 5000), 1), 10000);
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_like := CASE WHEN v_q IS NULL THEN NULL ELSE '%' || v_q || '%' END;

  IF v_tool = 'review_requests' THEN
    RETURN QUERY
    WITH base AS (
      SELECT rr.*,
             tp.full_name AS tenant_name, tp.phone AS tenant_phone,
             ap.full_name AS agent_name, ap.phone AS agent_phone,
             lp.full_name AS landlord_name
      FROM rent_requests rr
      LEFT JOIN profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN profiles ap ON ap.id = rr.agent_id
      LEFT JOIN profiles lp ON lp.id = rr.landlord_id
      WHERE rr.status IN ('pending','service_center_review','agent_ops_approved','agent_verified','tenant_ops_approved','coo_approved','funded')
        AND (v_status = 'all' OR rr.status = v_status)
        AND (p_date_from IS NULL OR rr.created_at >= p_date_from)
        AND (p_date_to IS NULL OR rr.created_at < p_date_to)
        AND (v_like IS NULL OR tp.full_name ILIKE v_like OR tp.phone ILIKE v_like
             OR ap.full_name ILIKE v_like OR rr.request_city ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'agent_name', b.agent_name,
             'agent_phone', b.agent_phone,
             'landlord_name', b.landlord_name,
             'status', b.status,
             'rent_amount', COALESCE(b.rent_amount,0),
             'total_repayment', COALESCE(b.total_repayment,0),
             'daily_repayment', COALESCE(b.daily_repayment,0),
             'duration_days', b.duration_days,
             'house_category', b.house_category,
             'request_city', b.request_city,
             'request_country', b.request_country,
             'has_gps', (b.request_latitude IS NOT NULL AND b.request_longitude IS NOT NULL),
             'registration_type', b.registration_type,
             'service_center_reviewed_at', b.service_center_reviewed_at,
             'agent_verified_at', b.agent_verified_at,
             'tenant_ops_reviewed_at', b.tenant_ops_reviewed_at,
             'resubmission_count', COALESCE(b.resubmission_count,0),
             'created_at', b.created_at,
             'updated_at', b.updated_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY b.created_at DESC
    LIMIT v_limit;

  ELSIF v_tool = 'approval_history' THEN
    RETURN QUERY
    WITH base AS (
      SELECT rr.*,
             tp.full_name AS tenant_name, tp.phone AS tenant_phone,
             ap.full_name AS agent_name,
             t1.full_name AS tenant_ops_by, a1.full_name AS agent_ops_by,
             l1.full_name AS landlord_ops_by, c1.full_name AS coo_by, f1.full_name AS cfo_by
      FROM rent_requests rr
      LEFT JOIN profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN profiles ap ON ap.id = rr.agent_id
      LEFT JOIN profiles t1 ON t1.id = rr.tenant_ops_reviewed_by
      LEFT JOIN profiles a1 ON a1.id = rr.agent_verified_by
      LEFT JOIN profiles l1 ON l1.id = rr.landlord_ops_reviewed_by
      LEFT JOIN profiles c1 ON c1.id = rr.coo_reviewed_by
      LEFT JOIN profiles f1 ON f1.id = rr.cfo_reviewed_by
      WHERE (
              rr.tenant_ops_reviewed_at IS NOT NULL OR rr.agent_verified_at IS NOT NULL
              OR rr.landlord_ops_reviewed_at IS NOT NULL OR rr.coo_reviewed_at IS NOT NULL
              OR rr.cfo_reviewed_at IS NOT NULL OR rr.status IN ('rejected','funded','repaying','completed','defaulted')
            )
        AND (v_status = 'all' OR rr.status = v_status)
        AND (p_date_from IS NULL OR rr.updated_at >= p_date_from)
        AND (p_date_to IS NULL OR rr.updated_at < p_date_to)
        AND (v_like IS NULL OR tp.full_name ILIKE v_like OR tp.phone ILIKE v_like OR ap.full_name ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'agent_name', b.agent_name,
             'status', b.status,
             'rent_amount', COALESCE(b.rent_amount,0),
             'request_city', b.request_city,
             'house_category', b.house_category,
             'tenant_ops_by', b.tenant_ops_by, 'tenant_ops_at', b.tenant_ops_reviewed_at,
             'agent_ops_by', b.agent_ops_by, 'agent_ops_at', b.agent_verified_at,
             'landlord_ops_by', b.landlord_ops_by, 'landlord_ops_at', b.landlord_ops_reviewed_at,
             'coo_by', b.coo_by, 'coo_at', b.coo_reviewed_at,
             'cfo_by', b.cfo_by, 'cfo_at', b.cfo_reviewed_at,
             'rejected_reason', b.rejected_reason,
             'rejected_at_stage', b.rejected_at_stage,
             'approval_comment', b.approval_comment,
             'created_at', b.created_at,
             'updated_at', b.updated_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY b.updated_at DESC
    LIMIT v_limit;

  ELSIF v_tool = 'missed_days' THEN
    RETURN QUERY
    WITH calc AS (
      SELECT rr.id, rr.tenant_id, rr.agent_id, rr.status, rr.disbursed_at,
             COALESCE(rr.rent_amount,0) AS rent_amount,
             COALESCE(rr.total_repayment,0) AS total_repayment,
             COALESCE(rr.amount_repaid,0) AS amount_repaid,
             COALESCE(rr.daily_repayment,0) AS daily_repayment,
             GREATEST(1, (date_part('day', now() - rr.disbursed_at))::int) AS days_since,
             LEAST(COALESCE(rr.daily_repayment,0) * GREATEST(1, (date_part('day', now() - rr.disbursed_at))::int), COALESCE(rr.total_repayment,0)) AS expected_repaid
      FROM rent_requests rr
      WHERE rr.status IN ('funded','disbursed','repaying')
        AND rr.disbursed_at IS NOT NULL
        AND (p_date_from IS NULL OR rr.disbursed_at >= p_date_from)
        AND (p_date_to IS NULL OR rr.disbursed_at < p_date_to)
    ), enriched AS (
      SELECT c.*,
             GREATEST(0, floor((c.expected_repaid - c.amount_repaid) / NULLIF(c.daily_repayment,0)))::int AS missed_days,
             GREATEST(0, c.total_repayment - c.amount_repaid) AS outstanding_balance,
             tp.full_name AS tenant_name, tp.phone AS tenant_phone,
             ap.full_name AS agent_name, ap.phone AS agent_phone,
             (SELECT max(ac.created_at) FROM agent_collections ac WHERE ac.tenant_id = c.tenant_id) AS last_payment_at,
             (SELECT COALESCE(sum(ac.amount),0) FROM agent_collections ac WHERE ac.tenant_id = c.tenant_id) AS lifetime_collected
      FROM calc c
      LEFT JOIN profiles tp ON tp.id = c.tenant_id
      LEFT JOIN profiles ap ON ap.id = c.agent_id
    ), base AS (
      SELECT e.*,
             CASE WHEN e.missed_days >= 5 THEN 'critical'
                  WHEN e.missed_days >= 2 THEN 'warning'
                  ELSE 'on_track' END AS risk_level
      FROM enriched e
    ), filtered AS (
      SELECT * FROM base b
      WHERE (v_status = 'all' OR b.risk_level = v_status)
        AND (v_like IS NULL OR b.tenant_name ILIKE v_like OR b.tenant_phone ILIKE v_like OR b.agent_name ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM filtered)
    SELECT jsonb_build_object(
             'id', f.id,
             'tenant_id', f.tenant_id,
             'tenant_name', COALESCE(f.tenant_name, 'Unknown'),
             'tenant_phone', f.tenant_phone,
             'agent_name', f.agent_name,
             'agent_phone', f.agent_phone,
             'status', f.status,
             'risk_level', f.risk_level,
             'missed_days', f.missed_days,
             'days_since_disbursed', f.days_since,
             'daily_repayment', f.daily_repayment,
             'rent_amount', f.rent_amount,
             'total_repayment', f.total_repayment,
             'amount_repaid', f.amount_repaid,
             'expected_repaid', f.expected_repaid,
             'outstanding_balance', f.outstanding_balance,
             'repayment_pct', CASE WHEN f.total_repayment > 0 THEN round((f.amount_repaid / f.total_repayment) * 100, 1) ELSE 0 END,
             'lifetime_collected', f.lifetime_collected,
             'last_payment_at', f.last_payment_at,
             'disbursed_at', f.disbursed_at
           ), (SELECT c FROM counted)
    FROM filtered f
    ORDER BY f.missed_days DESC, f.outstanding_balance DESC
    LIMIT v_limit;

  ELSIF v_tool = 'daily_payments' THEN
    RETURN QUERY
    WITH base AS (
      SELECT ac.*, tp.full_name AS tenant_name, tp.phone AS tenant_phone,
             ap.full_name AS agent_name, ap.phone AS agent_phone
      FROM agent_collections ac
      LEFT JOIN profiles tp ON tp.id = ac.tenant_id
      LEFT JOIN profiles ap ON ap.id = ac.agent_id
      WHERE (p_date_from IS NULL OR ac.created_at >= p_date_from)
        AND (p_date_to IS NULL OR ac.created_at < p_date_to)
        AND (v_status = 'all' OR lower(COALESCE(ac.payment_method,'unknown')) = v_status)
        AND (v_like IS NULL OR tp.full_name ILIKE v_like OR tp.phone ILIKE v_like
             OR ap.full_name ILIKE v_like OR ac.location_name ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'agent_name', b.agent_name,
             'agent_phone', b.agent_phone,
             'amount', COALESCE(b.amount,0),
             'payment_method', COALESCE(b.payment_method,'unknown'),
             'momo_provider', b.momo_provider,
             'momo_transaction_id', b.momo_transaction_id,
             'tracking_id', b.tracking_id,
             'location_name', b.location_name,
             'rent_request_id', b.rent_request_id,
             'notes', b.notes,
             'created_at', b.created_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY b.created_at DESC
    LIMIT v_limit;

  ELSIF v_tool = 'tenant_behavior' THEN
    RETURN QUERY
    WITH base AS (
      SELECT * FROM public.search_tenant_behavior(v_q, v_status, v_limit, 0)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'tenant_id', b.tenant_id,
             'tenant_name', COALESCE(b.full_name, 'Unknown'),
             'tenant_phone', b.phone,
             'risk_level', b.risk_level,
             'health_score', b.health_score,
             'total_requests', b.total_requests,
             'active_requests', b.active_requests,
             'fully_repaid_count', b.fully_repaid_count,
             'defaulted_count', b.defaulted_count,
             'total_rent_amount', b.total_rent_amount,
             'total_repaid', b.total_repaid,
             'repayment_pct', b.repayment_pct,
             'current_overdue_amount', b.current_overdue_amount,
             'on_time_payments', b.on_time_payments,
             'missed_payments', b.missed_payments,
             'last_payment_date', b.last_payment_date,
             'first_request_date', b.first_request_date
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY b.health_score ASC NULLS LAST
    LIMIT v_limit;

  ELSIF v_tool = 'transfer_audit' THEN
    RETURN QUERY
    WITH base AS (
      SELECT tt.*, tp.full_name AS tenant_name, tp.phone AS tenant_phone,
             fa.full_name AS from_agent_name, ta.full_name AS to_agent_name,
             ab.full_name AS actor_name
      FROM tenant_transfers tt
      LEFT JOIN profiles tp ON tp.id = tt.tenant_id
      LEFT JOIN profiles fa ON fa.id = tt.from_agent_id
      LEFT JOIN profiles ta ON ta.id = tt.to_agent_id
      LEFT JOIN profiles ab ON ab.id = tt.transferred_by
      WHERE (p_date_from IS NULL OR tt.created_at >= p_date_from)
        AND (p_date_to IS NULL OR tt.created_at < p_date_to)
        AND (v_status = 'all' OR lower(COALESCE(tt.flag_type,'none')) = v_status)
        AND (v_like IS NULL OR tp.full_name ILIKE v_like OR tp.phone ILIKE v_like
             OR fa.full_name ILIKE v_like OR ta.full_name ILIKE v_like OR ab.full_name ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'from_agent_name', b.from_agent_name,
             'to_agent_name', b.to_agent_name,
             'actor_name', b.actor_name,
             'flag_type', COALESCE(b.flag_type,'none'),
             'reason', b.reason,
             'rent_requests_updated', COALESCE(b.rent_requests_updated,0),
             'subscriptions_updated', COALESCE(b.subscriptions_updated,0),
             'actor_location_status', b.actor_location_status,
             'has_gps', (b.actor_latitude IS NOT NULL AND b.actor_longitude IS NOT NULL),
             'created_at', b.created_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY b.created_at DESC
    LIMIT v_limit;

  ELSE
    RAISE EXCEPTION 'unknown tool: %', p_tool;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_tenant_ops_tool_report(text, text, text, timestamptz, timestamptz, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.ops_tenant_ops_tool_report(text, text, text, timestamptz, timestamptz, integer) TO authenticated, service_role;