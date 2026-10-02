CREATE OR REPLACE FUNCTION public.get_landlord_float_due_today()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_finance boolean;
  v_holders json;
  v_company numeric := 0;
  v_company_count integer := 0;
  v_funder numeric := 0;
  v_funder_count integer := 0;
BEGIN
  v_is_finance := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo');

  IF NOT v_is_finance THEN
    RAISE EXCEPTION 'Landlord float due-today detail is only visible to finance roles';
  END IF;

  WITH due_today AS (
    SELECT a.agent_id, a.landlord_name, a.remaining_amount, a.source
    FROM public.agent_landlord_float_allocations a
    JOIN public.rent_requests rr ON rr.id = a.rent_request_id
    WHERE a.status IN ('open', 'partially_paid')
      AND rr.funded_at IS NOT NULL
      AND (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date
  )
  SELECT COALESCE(json_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::json)
  INTO v_holders
  FROM (
    SELECT json_build_object(
             'agent_id', agent_id,
             'amount', SUM(remaining_amount),
             'landlord_names', array_agg(DISTINCT landlord_name),
             'rent_request_count', COUNT(*)
           ) AS x
    FROM due_today
    GROUP BY agent_id
  ) g;

  -- The CTE above is gone once its statement ends, so define it again here.
  WITH due_today AS (
    SELECT a.agent_id, a.landlord_name, a.remaining_amount, a.source
    FROM public.agent_landlord_float_allocations a
    JOIN public.rent_requests rr ON rr.id = a.rent_request_id
    WHERE a.status IN ('open', 'partially_paid')
      AND rr.funded_at IS NOT NULL
      AND (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date
  )
  SELECT
    COALESCE(SUM(remaining_amount) FILTER (WHERE source = 'partner_self_funding'), 0),
    COUNT(*) FILTER (WHERE source = 'partner_self_funding'),
    COALESCE(SUM(remaining_amount) FILTER (WHERE source <> 'partner_self_funding'), 0),
    COUNT(*) FILTER (WHERE source <> 'partner_self_funding')
  INTO v_funder, v_funder_count, v_company, v_company_count
  FROM due_today;

  RETURN json_build_object(
    'holders', v_holders,
    'company_amount', v_company,
    'company_count', v_company_count,
    'funder_amount', v_funder,
    'funder_count', v_funder_count,
    'computed_at', now()
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_landlord_float_due_today() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_float_due_today() TO authenticated;
