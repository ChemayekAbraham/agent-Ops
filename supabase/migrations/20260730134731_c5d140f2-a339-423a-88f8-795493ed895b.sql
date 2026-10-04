CREATE OR REPLACE FUNCTION public.get_agent_collections_detail(p_agent_id uuid, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT jsonb_build_object(
    'summary', (
      SELECT jsonb_build_object(
        'count', count(*)::int,
        'total', COALESCE(sum(ac.amount),0),
        'today', COALESCE(sum(ac.amount) FILTER (WHERE ac.created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Kampala')),0),
        'week', COALESCE(sum(ac.amount) FILTER (WHERE ac.created_at >= now() - interval '7 days'),0),
        'last_30d', COALESCE(sum(ac.amount) FILTER (WHERE ac.created_at >= now() - interval '30 days'),0),
        'tenants_paid', count(DISTINCT ac.tenant_id)::int,
        'avg_amount', COALESCE(avg(NULLIF(ac.amount,0)),0),
        'cash_total', COALESCE(sum(ac.amount) FILTER (WHERE ac.payment_method::text = 'cash'),0),
        'momo_total', COALESCE(sum(ac.amount) FILTER (WHERE ac.payment_method::text = 'mobile_money'),0),
        'wallet_total', COALESCE(sum(ac.amount) FILTER (WHERE ac.payment_method::text = 'in_app_wallet'),0),
        'last_collection_at', max(ac.created_at)
      ) FROM agent_collections ac WHERE ac.agent_id = p_agent_id
    ),
    'portfolio', (
      SELECT jsonb_build_object(
        'rent_total', COALESCE(sum(COALESCE(rr.total_repayment, rr.rent_amount, 0)),0),
        'repaid_total', COALESCE(sum(COALESCE(rr.amount_repaid,0)),0),
        'outstanding_total', COALESCE(sum(GREATEST(COALESCE(rr.total_repayment, rr.rent_amount,0) - COALESCE(rr.amount_repaid,0), 0)),0)
      )
      FROM rent_requests rr
      WHERE rr.agent_id = p_agent_id
        AND COALESCE(rr.agent_payment_status,'') <> 'not_paying'
    ),
    'rows', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'created_at') DESC) FROM (
        SELECT to_jsonb(r) AS x FROM (
          SELECT c.id,
                 c.amount,
                 c.payment_method::text AS payment_method,
                 c.momo_provider,
                 c.momo_transaction_id,
                 c.location_name,
                 c.created_at,
                 tp.full_name AS tenant_name,
                 tp.phone AS tenant_phone,
                 COALESCE(rq.total_repayment, rq.rent_amount, 0) AS rent_total,
                 COALESCE(rq.amount_repaid, 0) AS repaid_total,
                 GREATEST(COALESCE(rq.total_repayment, rq.rent_amount, 0) - COALESCE(rq.amount_repaid,0), 0) AS outstanding,
                 COALESCE(rq.daily_repayment, 0) AS daily_repayment
            FROM agent_collections c
            LEFT JOIN profiles tp ON tp.id = c.tenant_id
            LEFT JOIN LATERAL (
              SELECT rr.total_repayment, rr.rent_amount, rr.amount_repaid, rr.daily_repayment
                FROM rent_requests rr
               WHERE rr.id = c.rent_request_id
                  OR (c.rent_request_id IS NULL AND rr.tenant_id = c.tenant_id AND rr.agent_id = c.agent_id)
               ORDER BY (rr.id = c.rent_request_id) DESC, rr.created_at DESC
               LIMIT 1
            ) rq ON true
           WHERE c.agent_id = p_agent_id
           ORDER BY c.created_at DESC
           LIMIT GREATEST(COALESCE(p_limit,50), 1)
        ) r
      ) s
    ), '[]'::jsonb)
  ) INTO v;

  RETURN v;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_collections_detail(uuid, integer) TO authenticated;