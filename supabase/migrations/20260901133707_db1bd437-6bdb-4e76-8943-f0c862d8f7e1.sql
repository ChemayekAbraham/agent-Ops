CREATE OR REPLACE FUNCTION public.get_partner_capital_management_split(p_as_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_total numeric := 0;
  v_self numeric := 0;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the partner capital breakdown';
  END IF;

  -- Presentation split only: partner capital that is deployed against houses
  -- whose landlord record is self managed (is_agent_managed = false) versus
  -- company managed. Nothing is written and no amount is invented.
  SELECT COALESCE(SUM(psh.principal),0),
         COALESCE(SUM(psh.principal) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM landlords ld
             WHERE ld.id = psh.landlord_id
               AND COALESCE(ld.is_agent_managed,false) = false
           )
         ),0)
  INTO v_total, v_self
  FROM partner_supported_houses psh
  WHERE psh.status NOT IN ('cancelled')
    AND psh.created_at <= p_as_at;

  RETURN jsonb_build_object(
    'as_at', p_as_at,
    'total', ROUND(v_total),
    'self_managed', ROUND(v_self),
    'company_managed', ROUND(v_total) - ROUND(v_self)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_partner_capital_management_split(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_partner_capital_management_split(timestamptz) TO authenticated, service_role;