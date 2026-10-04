CREATE OR REPLACE FUNCTION public.get_service_center_tenant_payments(
  p_rent_request_id uuid,
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_manager uuid := auth.uid();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_tenant uuid;
  v_agent uuid;
  v_stamped uuid;
  v_allowed boolean := false;
  v_total int;
  v_sum numeric;
  v_items jsonb;
BEGIN
  IF v_manager IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT rr.tenant_id, COALESCE(rr.agent_id, rr.assigned_agent_id), rr.service_center_manager_id
    INTO v_tenant, v_agent, v_stamped
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;

  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Rent request not found'; END IF;

  v_allowed := (
    v_stamped = v_manager
    OR v_agent = v_manager
    OR v_tenant = v_manager
    OR public.is_ops_role(v_manager)
    OR public.resolve_service_center_manager_for_agent(v_agent) = v_manager
  );

  IF NOT v_allowed AND v_agent IS NOT NULL THEN
    WITH RECURSIVE downline AS (
      SELECT s.sub_agent_id
      FROM public.agent_subagents s
      WHERE s.parent_agent_id = v_manager
        AND s.status IN ('verified','pending_acceptance')
      UNION
      SELECT s.sub_agent_id
      FROM public.agent_subagents s
      JOIN downline d ON d.sub_agent_id = s.parent_agent_id
      WHERE s.status IN ('verified','pending_acceptance')
    )
    SELECT EXISTS (SELECT 1 FROM downline WHERE sub_agent_id = v_agent) INTO v_allowed;
  END IF;

  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'You are not linked to this tenant''s rent plan, so its payment history is not visible to you';
  END IF;

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
           c.payment_method::text AS method,
           COALESCE(c.momo_transaction_id, c.tracking_id)::text AS reference,
           ap.full_name::text AS collected_by
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
$$;

REVOKE ALL ON FUNCTION public.get_service_center_tenant_payments(uuid, int, int) FROM public;
GRANT EXECUTE ON FUNCTION public.get_service_center_tenant_payments(uuid, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_service_center_tenant_payments(uuid, int, int) TO service_role;