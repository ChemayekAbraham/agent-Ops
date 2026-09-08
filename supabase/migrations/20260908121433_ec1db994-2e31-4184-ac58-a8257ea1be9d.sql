CREATE OR REPLACE FUNCTION public.rent_pipeline_tenant_history(
  p_tenant_id uuid,
  p_exclude_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_allowed boolean;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_result jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN jsonb_build_object('classification', 'new', 'plans', '[]'::jsonb);
  END IF;

  v_allowed :=
       current_user IN ('service_role','postgres','supabase_admin')
    OR public.agent_ops_report_authorized()
    OR public.has_role(v_uid, 'tenant_ops')
    OR public.has_role(v_uid, 'landlord_ops')
    OR public.has_role(v_uid, 'partner_ops')
    OR public.has_role(v_uid, 'financial_ops')
    OR public.has_role(v_uid, 'crm')
    OR v_uid = p_tenant_id
    OR EXISTS (
         SELECT 1 FROM public.rent_requests rr
         WHERE rr.tenant_id = p_tenant_id
           AND v_uid IN (rr.agent_id, rr.assigned_agent_id, rr.proxy_agent_id, rr.landlord_id)
       );
  IF NOT coalesce(v_allowed, false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  WITH plans AS (
    SELECT
      rr.id,
      rr.created_at,
      rr.approved_at,
      rr.funded_at,
      rr.disbursed_at,
      rr.status,
      rr.tenancy_status,
      rr.tenancy_ended_at,
      rr.tenancy_end_reason,
      rr.rejected_reason,
      rr.rejected_at_stage,
      rr.rent_amount,
      rr.total_repayment,
      coalesce(rr.amount_repaid, 0)::numeric AS amount_repaid,
      rr.daily_repayment,
      rr.duration_days,
      rr.repayment_frequency,
      rr.registration_type,
      rr.request_city,
      rr.landlord_id,
      coalesce(rr.assigned_agent_id, rr.agent_id) AS agent_id,
      coalesce(rr.repayment_starts_on, rr.funded_at::date, rr.disbursed_at::date) AS starts_on,
      (rr.status IN ('coo_approved','funded','repaying','completed'))            AS reached_approval,
      (rr.status IN ('funded','repaying','completed'))                           AS was_funded
    FROM public.rent_requests rr
    WHERE rr.tenant_id = p_tenant_id
      AND (p_exclude_request_id IS NULL OR rr.id <> p_exclude_request_id)
      AND rr.status <> 'deleted_by_agent'
  ),
  pays AS (
    SELECT ac.rent_request_id,
           count(*)                    AS payments_count,
           sum(ac.amount)              AS paid_total,
           min(ac.created_at)          AS first_payment_at,
           max(ac.created_at)          AS last_payment_at
    FROM public.agent_collections ac
    WHERE ac.tenant_id = p_tenant_id AND ac.amount > 0
    GROUP BY ac.rent_request_id
  ),
  enriched AS (
    SELECT
      p.*,
      CASE
        WHEN NOT p.was_funded OR p.starts_on IS NULL OR p.starts_on > v_today THEN 0
        WHEN p.status = 'completed' THEN coalesce(p.total_repayment, 0)
        WHEN p.repayment_frequency = 'weekly' THEN
          least(coalesce(p.total_repayment, 0),
                floor(((v_today - p.starts_on) / 7) + 1) * coalesce(p.daily_repayment, 0) * 7)
        ELSE
          least(coalesce(p.total_repayment, 0),
                ((v_today - p.starts_on) + 1) * coalesce(p.daily_repayment, 0))
      END AS expected_to_date,
      coalesce(py.payments_count, 0) AS payments_count,
      py.first_payment_at,
      py.last_payment_at,
      lp.full_name  AS landlord_name,
      ap.full_name  AS agent_name
    FROM plans p
    LEFT JOIN pays py ON py.rent_request_id = p.id
    LEFT JOIN public.profiles lp ON lp.id = p.landlord_id
    LEFT JOIN public.profiles ap ON ap.id = p.agent_id
  ),
  agg AS (
    SELECT
      count(*)                                            AS total_requests,
      count(*) FILTER (WHERE reached_approval)            AS approved_plans,
      count(*) FILTER (WHERE was_funded)                  AS funded_plans,
      count(*) FILTER (WHERE status = 'completed')        AS completed_plans,
      count(*) FILTER (WHERE status IN ('funded','repaying')) AS active_plans,
      count(*) FILTER (WHERE status = 'rejected')         AS rejected_requests,
      count(*) FILTER (WHERE status IN ('cancelled'))     AS cancelled_requests,
      count(*) FILTER (WHERE tenancy_status IS NOT NULL AND tenancy_status NOT IN ('active','ongoing')) AS ended_tenancies,
      coalesce(sum(rent_amount)      FILTER (WHERE was_funded), 0) AS total_rent_financed,
      coalesce(sum(total_repayment)  FILTER (WHERE was_funded), 0) AS total_obligation,
      coalesce(sum(amount_repaid)    FILTER (WHERE was_funded), 0) AS total_repaid,
      coalesce(sum(greatest(coalesce(total_repayment,0) - amount_repaid, 0)) FILTER (WHERE status IN ('funded','repaying')), 0) AS outstanding_active,
      coalesce(sum(expected_to_date) FILTER (WHERE was_funded), 0) AS expected_to_date,
      coalesce(sum(least(amount_repaid, expected_to_date)) FILTER (WHERE was_funded), 0) AS repaid_against_expected,
      coalesce(sum(payments_count), 0)                    AS payments_count,
      min(first_payment_at)                               AS first_payment_at,
      max(last_payment_at)                                AS last_payment_at,
      min(created_at)                                     AS first_request_at,
      max(created_at)                                     AS last_request_at
    FROM enriched
  )
  SELECT jsonb_build_object(
    'classification', CASE WHEN a.approved_plans > 0 THEN 'renewing' ELSE 'new' END,
    'counts', jsonb_build_object(
      'total_requests',     a.total_requests,
      'approved_plans',     a.approved_plans,
      'funded_plans',       a.funded_plans,
      'completed_plans',    a.completed_plans,
      'active_plans',       a.active_plans,
      'rejected_requests',  a.rejected_requests,
      'cancelled_requests', a.cancelled_requests,
      'ended_tenancies',    a.ended_tenancies,
      'payments_count',     a.payments_count
    ),
    'totals', jsonb_build_object(
      'rent_financed',      a.total_rent_financed,
      'obligation',         a.total_obligation,
      'repaid',             a.total_repaid,
      'outstanding_active', a.outstanding_active,
      'expected_to_date',   a.expected_to_date
    ),
    'performance', jsonb_build_object(
      'repayment_rate',     CASE WHEN a.expected_to_date > 0
                                 THEN round(a.repaid_against_expected * 100.0 / a.expected_to_date, 1)
                                 ELSE NULL END,
      'assessment',         CASE
                              WHEN a.funded_plans = 0 OR a.expected_to_date <= 0 THEN NULL
                              WHEN a.repaid_against_expected * 100.0 / a.expected_to_date >= 90 THEN 'good'
                              WHEN a.repaid_against_expected * 100.0 / a.expected_to_date >= 60 THEN 'average'
                              ELSE 'poor'
                            END,
      'first_payment_at',   a.first_payment_at,
      'last_payment_at',    a.last_payment_at,
      'first_request_at',   a.first_request_at,
      'last_request_at',    a.last_request_at
    ),
    'plans', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id',                  e.id,
        'created_at',          e.created_at,
        'approved_at',         e.approved_at,
        'funded_at',           e.funded_at,
        'starts_on',           e.starts_on,
        'status',              e.status,
        'tenancy_status',      e.tenancy_status,
        'tenancy_ended_at',    e.tenancy_ended_at,
        'tenancy_end_reason',  e.tenancy_end_reason,
        'rejected_reason',     e.rejected_reason,
        'rejected_at_stage',   e.rejected_at_stage,
        'rent_amount',         e.rent_amount,
        'total_repayment',     e.total_repayment,
        'amount_repaid',       e.amount_repaid,
        'expected_to_date',    e.expected_to_date,
        'daily_repayment',     e.daily_repayment,
        'duration_days',       e.duration_days,
        'repayment_frequency', e.repayment_frequency,
        'registration_type',   e.registration_type,
        'request_city',        e.request_city,
        'landlord_name',       e.landlord_name,
        'agent_name',          e.agent_name,
        'payments_count',      e.payments_count,
        'first_payment_at',    e.first_payment_at,
        'last_payment_at',     e.last_payment_at
      ) ORDER BY e.created_at DESC)
      FROM (SELECT * FROM enriched ORDER BY created_at DESC LIMIT 30) e
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM agg a;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.rent_pipeline_tenant_history(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_pipeline_tenant_history(uuid, uuid) TO authenticated, service_role;