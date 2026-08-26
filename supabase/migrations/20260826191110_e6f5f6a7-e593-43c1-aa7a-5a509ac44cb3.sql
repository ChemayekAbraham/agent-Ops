CREATE OR REPLACE FUNCTION public.agent_ops_partial_collection_report(p_days integer DEFAULT 30, p_limit integer DEFAULT 15, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_days integer := GREATEST(1, LEAST(365, COALESCE(p_days, 30)));
  v_limit integer := GREATEST(1, LEAST(100, COALESCE(p_limit, 15)));
  v_offset integer := GREATEST(0, COALESCE(p_offset, 0));
  v_from timestamptz;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'agent_ops'::public.app_role)
    OR public.has_role(v_uid, 'tenant_ops'::public.app_role)
    OR public.has_role(v_uid, 'landlord_ops'::public.app_role)
    OR public.has_role(v_uid, 'partner_ops'::public.app_role)
    OR public.has_role(v_uid, 'operations'::public.app_role)
    OR public.has_role(v_uid, 'manager'::public.app_role)
    OR public.has_role(v_uid, 'coo'::public.app_role)
    OR public.has_role(v_uid, 'ceo'::public.app_role)
    OR public.has_role(v_uid, 'super_admin'::public.app_role)
    OR public.has_role(v_uid, 'admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Operations role required' USING ERRCODE = '42501';
  END IF;

  v_from := now() - make_interval(days => v_days);

  WITH day_rows AS (
    SELECT ac.agent_id,
           ac.tenant_id,
           ac.rent_request_id,
           (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS collected_on,
           SUM(ac.amount) AS collected,
           MAX(ac.created_at) AS last_at,
           MAX(COALESCE(ac.partial_reason, '')) AS reason
      FROM public.agent_collections ac
     WHERE ac.created_at >= v_from
       AND ac.rent_request_id IS NOT NULL
     GROUP BY 1,2,3,4
  ), scored AS (
    SELECT d.*,
           COALESCE(rr.daily_repayment, 0) AS expected,
           GREATEST(0, COALESCE(rr.daily_repayment, 0) - d.collected) AS shortfall,
           crd.repayment_frequency
      FROM day_rows d
      JOIN public.rent_requests rr ON rr.id = d.rent_request_id
      LEFT JOIN public.credit_request_details crd ON crd.loan_id = rr.id
  ), totals AS (
    SELECT COUNT(*) AS paid_days,
           COUNT(*) FILTER (WHERE shortfall > 0) AS partial_days,
           COALESCE(SUM(collected), 0) AS collected_total,
           COALESCE(SUM(expected), 0) AS expected_total,
           COALESCE(SUM(shortfall), 0) AS shortfall_total,
           COUNT(DISTINCT agent_id) FILTER (WHERE shortfall > 0) AS agents_affected,
           COUNT(DISTINCT tenant_id) FILTER (WHERE shortfall > 0) AS tenants_affected
      FROM scored
  ), by_agent AS (
    SELECT s.agent_id,
           COALESCE(pr.full_name, 'Unknown agent') AS agent_name,
           pr.phone AS agent_phone,
           COUNT(*) AS paid_days,
           COUNT(*) FILTER (WHERE s.shortfall > 0) AS partial_days,
           COALESCE(SUM(s.collected), 0) AS collected,
           COALESCE(SUM(s.expected), 0) AS expected,
           COALESCE(SUM(s.shortfall), 0) AS shortfall,
           COUNT(DISTINCT s.tenant_id) FILTER (WHERE s.shortfall > 0) AS tenants_short,
           MAX(s.last_at) AS last_collection_at
      FROM scored s
      LEFT JOIN public.profiles pr ON pr.id = s.agent_id
     GROUP BY 1,2,3
  ), by_tenant AS (
    SELECT s.tenant_id,
           s.rent_request_id,
           COALESCE(tp.full_name, 'Unknown tenant') AS tenant_name,
           tp.phone AS tenant_phone,
           COALESCE(ap.full_name, 'Unassigned') AS agent_name,
           s.agent_id,
           COUNT(*) AS paid_days,
           COUNT(*) FILTER (WHERE s.shortfall > 0) AS partial_days,
           COALESCE(SUM(s.collected), 0) AS collected,
           COALESCE(SUM(s.expected), 0) AS expected,
           COALESCE(SUM(s.shortfall), 0) AS shortfall,
           MAX(s.last_at) AS last_collection_at,
           MAX(NULLIF(s.reason, '')) AS last_reason,
           MAX(s.repayment_frequency) AS repayment_frequency
      FROM scored s
      LEFT JOIN public.profiles tp ON tp.id = s.tenant_id
      LEFT JOIN public.profiles ap ON ap.id = s.agent_id
     GROUP BY 1,2,3,4,5,6
  ), recent AS (
    SELECT ac.id,
           ac.created_at,
           ac.amount,
           ac.expected_amount,
           ac.shortfall_amount,
           ac.partial_reason,
           ac.payment_method::text AS payment_method,
           COALESCE(tp.full_name, 'Unknown tenant') AS tenant_name,
           tp.phone AS tenant_phone,
           COALESCE(ap.full_name, 'Unknown agent') AS agent_name
      FROM public.agent_collections ac
      LEFT JOIN public.profiles tp ON tp.id = ac.tenant_id
      LEFT JOIN public.profiles ap ON ap.id = ac.agent_id
     WHERE ac.created_at >= v_from
       AND ac.is_partial = true
     ORDER BY ac.created_at DESC
     LIMIT v_limit OFFSET v_offset
  ), recent_total AS (
    SELECT COUNT(*) AS n
      FROM public.agent_collections ac
     WHERE ac.created_at >= v_from
       AND ac.is_partial = true
  )
  SELECT jsonb_build_object(
    'days', v_days,
    'generated_at', now(),
    'totals', (SELECT row_to_json(t) FROM totals t),
    'confirmed_partials_total', (SELECT n FROM recent_total),
    'by_agent', COALESCE((SELECT jsonb_agg(row_to_json(a) ORDER BY a.shortfall DESC) FROM by_agent a), '[]'::jsonb),
    'by_tenant', COALESCE((SELECT jsonb_agg(row_to_json(bt) ORDER BY bt.shortfall DESC) FROM by_tenant bt WHERE bt.shortfall > 0), '[]'::jsonb),
    'confirmed_partials', COALESCE((SELECT jsonb_agg(row_to_json(r)) FROM recent r), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_ops_partial_collection_report(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_ops_partial_collection_report(integer, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.agent_ops_partial_collection_report(integer, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_ops_partial_collection_report(integer, integer, integer) TO service_role;