CREATE OR REPLACE FUNCTION public.get_service_center_pipeline(
  p_statuses text[] DEFAULT NULL,
  p_limit int DEFAULT 10,
  p_offset int DEFAULT 0,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_manager uuid := auth.uid();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_total int;
  v_counts jsonb;
  v_items jsonb;
BEGIN
  IF v_manager IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  WITH subs AS (
    SELECT s.sub_agent_id
    FROM public.agent_subagents s
    WHERE s.parent_agent_id = v_manager
      AND s.status IN ('verified','pending_acceptance')
  ),
  scoped AS (
    SELECT rr.*
    FROM public.rent_requests rr
    WHERE rr.status NOT IN ('deleted_by_agent')
      AND (
        rr.service_center_manager_id = v_manager
        OR rr.agent_id IN (SELECT sub_agent_id FROM subs)
      )
  ),
  named AS (
    SELECT sc.*,
           tp.full_name AS tenant_name,
           tp.phone AS tenant_phone,
           ap.full_name AS agent_name
    FROM scoped sc
    LEFT JOIN public.profiles tp ON tp.id = sc.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = sc.agent_id
  ),
  searched AS (
    SELECT *
    FROM named n
    WHERE p_search IS NULL OR btrim(p_search) = ''
       OR n.tenant_name ILIKE '%' || btrim(p_search) || '%'
       OR n.agent_name ILIKE '%' || btrim(p_search) || '%'
       OR n.tenant_phone ILIKE '%' || btrim(p_search) || '%'
  ),
  filtered AS (
    SELECT * FROM searched s
    WHERE p_statuses IS NULL OR array_length(p_statuses, 1) IS NULL OR s.status = ANY (p_statuses)
  )
  SELECT
    (SELECT count(*) FROM filtered),
    (SELECT COALESCE(jsonb_object_agg(status, c), '{}'::jsonb)
       FROM (SELECT status, count(*) AS c FROM searched GROUP BY status) k),
    (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'id', f.id,
          'status', f.status,
          'created_at', f.created_at,
          'tenant_id', f.tenant_id,
          'tenant_name', f.tenant_name,
          'tenant_phone', f.tenant_phone,
          'agent_id', f.agent_id,
          'agent_name', f.agent_name,
          'rent_amount', f.rent_amount,
          'daily_repayment', f.daily_repayment,
          'total_repayment', f.total_repayment,
          'amount_repaid', COALESCE(f.amount_repaid, 0),
          'duration_days', f.duration_days,
          'request_city', f.request_city,
          'service_center_reviewed_at', f.service_center_reviewed_at,
          'service_center_comment', f.service_center_comment,
          'agent_ops_reviewed_at', f.agent_ops_reviewed_at,
          'agent_ops_comment', f.agent_ops_comment,
          'tenant_ops_reviewed_at', f.tenant_ops_reviewed_at,
          'tenant_ops_comment', f.tenant_ops_comment,
          'landlord_ops_reviewed_at', f.landlord_ops_reviewed_at,
          'landlord_ops_comment', f.landlord_ops_comment,
          'approved_at', f.approved_at,
          'approval_comment', f.approval_comment,
          'funded_at', f.funded_at,
          'is_mine_to_vet', (f.service_center_manager_id = v_manager)
        ) AS x
        FROM filtered f
        ORDER BY f.created_at DESC
        LIMIT v_limit OFFSET v_offset
     ) q)
  INTO v_total, v_counts, v_items;

  RETURN jsonb_build_object(
    'manager_id', v_manager,
    'is_service_center_manager', public.is_service_center_manager(v_manager),
    'total', COALESCE(v_total, 0),
    'limit', v_limit,
    'offset', v_offset,
    'status_counts', COALESCE(v_counts, '{}'::jsonb),
    'items', COALESCE(v_items, '[]'::jsonb)
  );
END;
$function$;