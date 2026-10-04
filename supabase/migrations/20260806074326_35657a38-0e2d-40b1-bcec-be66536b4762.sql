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

  CREATE TEMP TABLE IF NOT EXISTS _sc_scope (id uuid) ON COMMIT DROP;

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

REVOKE ALL ON FUNCTION public.get_service_center_pipeline(text[], int, int, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_service_center_pipeline(text[], int, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_service_center_pipeline(text[], int, int, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_service_center_tenant_payments(
  p_rent_request_id uuid,
  p_limit int DEFAULT 10,
  p_offset int DEFAULT 0
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
  v_tenant uuid;
  v_allowed boolean;
  v_total int;
  v_sum numeric;
  v_items jsonb;
BEGIN
  IF v_manager IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT rr.tenant_id,
         (
           rr.service_center_manager_id = v_manager
           OR rr.agent_id = v_manager
           OR rr.agent_id IN (
                SELECT s.sub_agent_id FROM public.agent_subagents s
                WHERE s.parent_agent_id = v_manager
                  AND s.status IN ('verified','pending_acceptance')
              )
           OR public.is_ops_role(v_manager)
         )
    INTO v_tenant, v_allowed
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;

  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Rent request not found'; END IF;
  IF NOT COALESCE(v_allowed, false) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  WITH pays AS (
    SELECT r.id,
           r.created_at AS paid_at,
           r.amount,
           'repayment'::text AS source,
           NULL::text AS method,
           NULL::text AS reference,
           NULL::text AS collected_by
    FROM public.repayments r
    WHERE r.rent_request_id = p_rent_request_id
    UNION ALL
    SELECT c.id,
           c.created_at AS paid_at,
           c.amount,
           'agent_collection'::text AS source,
           c.payment_method AS method,
           COALESCE(c.momo_transaction_id, c.tracking_id) AS reference,
           ap.full_name AS collected_by
    FROM public.agent_collections c
    LEFT JOIN public.profiles ap ON ap.id = c.agent_id
    WHERE c.rent_request_id = p_rent_request_id
       OR (c.rent_request_id IS NULL AND c.tenant_id = v_tenant)
  )
  SELECT (SELECT count(*) FROM pays),
         (SELECT COALESCE(SUM(amount), 0) FROM pays),
         (SELECT COALESCE(jsonb_agg(y), '[]'::jsonb) FROM (
            SELECT jsonb_build_object(
              'id', p.id,
              'paid_at', p.paid_at,
              'amount', p.amount,
              'source', p.source,
              'method', p.method,
              'reference', p.reference,
              'collected_by', p.collected_by
            ) AS y
            FROM pays p
            ORDER BY p.paid_at DESC
            LIMIT v_limit OFFSET v_offset
          ) q)
    INTO v_total, v_sum, v_items;

  RETURN jsonb_build_object(
    'rent_request_id', p_rent_request_id,
    'total', COALESCE(v_total, 0),
    'total_amount', COALESCE(v_sum, 0),
    'limit', v_limit,
    'offset', v_offset,
    'items', COALESCE(v_items, '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_service_center_tenant_payments(uuid, int, int) FROM public;
GRANT EXECUTE ON FUNCTION public.get_service_center_tenant_payments(uuid, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_service_center_tenant_payments(uuid, int, int) TO service_role;