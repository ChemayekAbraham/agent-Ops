CREATE OR REPLACE FUNCTION public.landlord_ops_principal_recovered_rows(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE(id uuid, repayment_date timestamptz, rent_request_id uuid, tenant_name text, landlord_name text,
  total_repayment numeric, principal numeric, access_fee numeric, registration_fee numeric,
  returns numeric, agent_commission numeric, platform_fee numeric, plan_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['landlord_ops','cfo','ceo','coo','manager','financial_ops','super_admin','cto']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT ia.id, ia.instalment_date, ia.rent_request_id, p.full_name::text, l.name::text,
    COALESCE(ia.instalment_amount,0), COALESCE(ia.principal_component,0), COALESCE(ia.access_fee_component,0),
    COALESCE(ia.registration_fee_component,0), COALESCE(ia.partner_reward_component,0),
    COALESCE(ia.agent_commission_component,0), COALESCE(ia.platform_net_component,0), rr.status::text
  FROM public.instalment_allocations ia
  LEFT JOIN public.rent_requests rr ON rr.id = ia.rent_request_id
  LEFT JOIN public.profiles p ON p.id = rr.tenant_id
  LEFT JOIN public.landlords l ON l.id = rr.landlord_id
  WHERE ia.reversed_at IS NULL
    AND (p_from IS NULL OR (ia.instalment_date AT TIME ZONE 'Africa/Kampala')::date >= p_from)
    AND (p_to IS NULL OR (ia.instalment_date AT TIME ZONE 'Africa/Kampala')::date <= p_to)
  ORDER BY ia.instalment_date DESC;
END $$;
REVOKE ALL ON FUNCTION public.landlord_ops_principal_recovered_rows(date,date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.landlord_ops_principal_recovered_rows(date,date) TO authenticated;