CREATE TABLE public.tenant_call_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rent_request_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('picked_up','missed')),
  comment text,
  called_by uuid NOT NULL,
  called_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tenant_call_reports_tenant ON public.tenant_call_reports (tenant_id, called_at DESC);
GRANT SELECT, INSERT ON public.tenant_call_reports TO authenticated;
GRANT ALL ON public.tenant_call_reports TO service_role;
ALTER TABLE public.tenant_call_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops staff read tenant call reports" ON public.tenant_call_reports
FOR SELECT TO authenticated
USING (
  public.is_ops_role((SELECT auth.uid()))
  OR public.has_role((SELECT auth.uid()), 'manager')
  OR public.has_role((SELECT auth.uid()), 'super_admin')
  OR public.has_role((SELECT auth.uid()), 'coo')
  OR public.has_role((SELECT auth.uid()), 'ceo')
  OR public.has_role((SELECT auth.uid()), 'cto')
);

CREATE POLICY "Ops staff log tenant calls" ON public.tenant_call_reports
FOR INSERT TO authenticated
WITH CHECK (
  called_by = (SELECT auth.uid())
  AND (
    public.is_ops_role((SELECT auth.uid()))
    OR public.has_role((SELECT auth.uid()), 'manager')
    OR public.has_role((SELECT auth.uid()), 'super_admin')
    OR public.has_role((SELECT auth.uid()), 'coo')
    OR public.has_role((SELECT auth.uid()), 'ceo')
    OR public.has_role((SELECT auth.uid()), 'cto')
  )
);

CREATE VIEW public.v_tenant_call_summary
WITH (security_invoker = true) AS
SELECT c.tenant_id,
       count(*)::int AS call_count,
       count(*) FILTER (WHERE c.outcome = 'picked_up')::int AS picked_up_count,
       count(*) FILTER (WHERE c.outcome = 'missed')::int AS missed_count,
       max(c.called_at) AS last_call_at,
       max(c.called_at) FILTER (WHERE c.outcome = 'picked_up') AS last_picked_up_at,
       (array_agg(c.outcome ORDER BY c.called_at DESC))[1] AS last_outcome,
       (array_agg(c.comment ORDER BY c.called_at DESC) FILTER (WHERE c.comment IS NOT NULL AND btrim(c.comment) <> ''))[1] AS latest_comment,
       (array_agg(c.called_at ORDER BY c.called_at DESC) FILTER (WHERE c.comment IS NOT NULL AND btrim(c.comment) <> ''))[1] AS latest_comment_at
FROM public.tenant_call_reports c
GROUP BY c.tenant_id;

GRANT SELECT ON public.v_tenant_call_summary TO authenticated;
GRANT SELECT ON public.v_tenant_call_summary TO service_role;

CREATE OR REPLACE FUNCTION public.ops_tenant_ops_tool_report(p_tool text, p_status text DEFAULT 'all'::text, p_search text DEFAULT NULL::text, p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 5000)
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

  ELSIF v_tool IN ('missed_days','calls_made') THEN
    RETURN QUERY
    WITH calc AS (
      -- `disbursed_at` is absent on most repaying plans, so the repayment clock
      -- is anchored on disbursed_at -> funded_at -> created_at. Filtering on
      -- disbursed_at alone hid the majority of active plans from this report.
      SELECT rr.id, rr.tenant_id, rr.agent_id, rr.status,
             COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at) AS disbursed_at,
             COALESCE(rr.rent_amount,0) AS rent_amount,
             COALESCE(rr.total_repayment,0) AS total_repayment,
             COALESCE(rr.amount_repaid,0) AS amount_repaid,
             COALESCE(rr.daily_repayment,0) AS daily_repayment,
             GREATEST(1, (date_part('day', now() - COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at)))::int) AS days_since,
             LEAST(COALESCE(rr.daily_repayment,0) * GREATEST(1, (date_part('day', now() - COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at)))::int), COALESCE(rr.total_repayment,0)) AS expected_repaid
      FROM rent_requests rr
      WHERE rr.status IN ('funded','disbursed','repaying')
        AND (p_date_from IS NULL OR COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at) >= p_date_from)
        AND (p_date_to IS NULL OR COALESCE(rr.disbursed_at, rr.funded_at, rr.created_at) < p_date_to)
    ), enriched AS (
      SELECT c.*,
             GREATEST(0, round((c.expected_repaid - c.amount_repaid) / NULLIF(c.daily_repayment,0)))::int AS missed_days,
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
      SELECT b.*,
             COALESCE(cs.call_count,0) AS call_count,
             cs.last_call_at, cs.last_outcome, cs.latest_comment,
             cs.last_picked_up_at
      FROM base b
      LEFT JOIN v_tenant_call_summary cs ON cs.tenant_id = b.tenant_id
      WHERE (v_status = 'all' OR b.risk_level = v_status)
        AND (v_like IS NULL OR b.tenant_name ILIKE v_like OR b.tenant_phone ILIKE v_like OR b.agent_name ILIKE v_like)
        AND (v_tool <> 'calls_made' OR COALESCE(cs.call_count,0) > 0)
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
             'disbursed_at', f.disbursed_at,
             'call_count', COALESCE(f.call_count,0),
             'last_call_at', f.last_call_at,
             'last_call_outcome', f.last_outcome,
             'last_picked_up_at', f.last_picked_up_at,
             'latest_call_comment', f.latest_comment
           ), (SELECT c FROM counted)
    FROM filtered f
    ORDER BY (CASE WHEN v_tool = 'calls_made' THEN f.last_call_at END) DESC NULLS LAST,
             f.missed_days DESC, f.outstanding_balance DESC
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
             OR ap.full_name ILIKE v_like OR ac.momo_transaction_id ILIKE v_like OR ac.tracking_id ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'agent_name', b.agent_name,
             'agent_phone', b.agent_phone,
             'amount', COALESCE(b.amount,0),
             'payment_method', b.payment_method,
             'momo_provider', b.momo_provider,
             'momo_transaction_id', b.momo_transaction_id,
             'tracking_id', b.tracking_id,
             'location_name', b.location_name,
             'rent_request_id', b.rent_request_id,
             'has_gps', (b.latitude IS NOT NULL AND b.longitude IS NOT NULL),
             'created_at', b.created_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY b.created_at DESC
    LIMIT v_limit;

  ELSIF v_tool = 'tenant_behavior' THEN
    RETURN QUERY
    WITH base AS (
      SELECT ts.*, tp.full_name AS tenant_name, tp.phone AS tenant_phone
      FROM tenant_trust_scores ts
      LEFT JOIN profiles tp ON tp.id = ts.tenant_id
      WHERE (p_date_from IS NULL OR ts.updated_at >= p_date_from)
        AND (p_date_to IS NULL OR ts.updated_at < p_date_to)
        AND (
          v_status = 'all'
          OR (v_status = 'excellent' AND COALESCE(ts.trust_score,0) >= 80)
          OR (v_status = 'good' AND COALESCE(ts.trust_score,0) >= 60 AND COALESCE(ts.trust_score,0) < 80)
          OR (v_status = 'fair' AND COALESCE(ts.trust_score,0) >= 40 AND COALESCE(ts.trust_score,0) < 60)
          OR (v_status = 'poor' AND COALESCE(ts.trust_score,0) < 40)
        )
        AND (v_like IS NULL OR tp.full_name ILIKE v_like OR tp.phone ILIKE v_like)
    ), counted AS (SELECT count(*) AS c FROM base)
    SELECT jsonb_build_object(
             'id', b.id,
             'tenant_id', b.tenant_id,
             'tenant_name', COALESCE(b.tenant_name, 'Unknown'),
             'tenant_phone', b.tenant_phone,
             'trust_score', COALESCE(b.trust_score,0),
             'on_time_payments', COALESCE(b.on_time_payments,0),
             'late_payments', COALESCE(b.late_payments,0),
             'missed_payments', COALESCE(b.missed_payments,0),
             'total_payments', COALESCE(b.total_payments,0),
             'consecutive_on_time', COALESCE(b.consecutive_on_time,0),
             'longest_streak', COALESCE(b.longest_streak,0),
             'avg_days_late', COALESCE(b.avg_days_late,0),
             'total_repaid', COALESCE(b.total_repaid,0),
             'last_payment_at', b.last_payment_at,
             'updated_at', b.updated_at
           ), (SELECT c FROM counted)
    FROM base b
    ORDER BY COALESCE(b.trust_score,0) DESC
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