CREATE OR REPLACE FUNCTION public.landlord_ops_float_drilldown(p_kind text, p_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       public.is_ops_role()
       OR has_role(v_uid,'landlord_ops') OR has_role(v_uid,'tenant_ops')
       OR has_role(v_uid,'agent_ops') OR has_role(v_uid,'operations')
       OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'cfo') OR has_role(v_uid,'coo') OR has_role(v_uid,'ceo')
       OR has_role(v_uid,'cto') OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the landlord float drilldown';
  END IF;

  IF p_kind = 'empty_houses' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'id', hl.id,
               'title', COALESCE(NULLIF(hl.title,''),'Untitled house'),
               'district', COALESCE(NULLIF(hl.district,''),'Unspecified'),
               'sub_county', hl.sub_county,
               'village', hl.village,
               'landlord_name', COALESCE(ld.name,'No landlord linked'),
               'landlord_phone', COALESCE(ld.phone, ld.mobile_money_number),
               'agent_name', ap.full_name,
               'verified', COALESCE(hl.verified,false),
               'amount', COALESCE(hl.monthly_rent,0),
               'created_at', hl.created_at
             ) AS x
      FROM house_listings hl
      LEFT JOIN landlords ld ON ld.id = hl.landlord_id
      LEFT JOIN profiles ap ON ap.id = hl.agent_id
      WHERE hl.tenant_id IS NULL
        AND COALESCE(hl.is_hidden,false) = false
        AND hl.status = 'available'
        AND (p_key IS NULL OR COALESCE(NULLIF(hl.district,''),'Unspecified') = p_key)
      ORDER BY COALESCE(hl.monthly_rent,0) DESC
      LIMIT 500
    ) s;

  ELSIF p_kind = 'payouts' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'created_at') DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'id', lp.id,
               'landlord_name', COALESCE(NULLIF(lp.landlord_name,''), ld.name, 'No landlord linked'),
               'landlord_phone', COALESCE(lp.landlord_phone, ld.phone),
               'tenant_name', tp.full_name,
               'agent_name', ap.full_name,
               'amount', COALESCE(lp.amount,0),
               'provider', lp.mobile_money_provider,
               'reference', COALESCE(lp.finops_momo_reference, lp.external_reference, lp.receipt_number),
               'disbursed_at', COALESCE(lp.finops_disbursed_at, lp.disbursed_at),
               'created_at', lp.created_at
             ) AS x
      FROM landlord_payouts lp
      LEFT JOIN landlords ld ON ld.id = lp.landlord_id
      LEFT JOIN profiles tp ON tp.id = lp.tenant_id
      LEFT JOIN profiles ap ON ap.id = lp.agent_id
      WHERE lp.status = 'completed'
        AND (p_key IS NULL OR lp.agent_id::text = p_key)
      ORDER BY lp.created_at DESC
      LIMIT 500
    ) s;

  ELSIF p_kind = 'portfolios' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'id', ip.id,
               'portfolio_code', ip.portfolio_code,
               'partner_name', COALESCE(pp.full_name,'Unnamed funder'),
               'partner_phone', pp.phone,
               'amount', COALESCE(ip.investment_amount,0),
               'status', ip.status,
               'duration_months', ip.duration_months,
               'created_at', ip.created_at,
               'maturity_date', ip.maturity_date
             ) AS x
      FROM investor_portfolios ip
      LEFT JOIN profiles pp ON pp.id = ip.investor_id
      WHERE ip.status IN ('active','locked')
      ORDER BY COALESCE(ip.investment_amount,0) DESC
      LIMIT 500
    ) s;

  ELSIF p_kind = 'attached_houses' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'id', psh.id,
               'partner_name', COALESCE(pp.full_name,'Unnamed funder'),
               'landlord_name', COALESCE(ld.name,'No landlord linked'),
               'house_title', COALESCE(NULLIF(hl.title,''),'Untitled house'),
               'district', COALESCE(NULLIF(hl.district,''),'Unspecified'),
               'amount', COALESCE(psh.principal,0),
               'status', psh.status,
               'supported_at', COALESCE(psh.activated_at, psh.supported_at, psh.created_at)
             ) AS x
      FROM partner_supported_houses psh
      LEFT JOIN profiles pp ON pp.id = psh.partner_id
      LEFT JOIN landlords ld ON ld.id = psh.landlord_id
      LEFT JOIN house_listings hl ON hl.id = psh.house_id
      WHERE psh.status <> 'cancelled'
      ORDER BY COALESCE(psh.principal,0) DESC
      LIMIT 500
    ) s;

  ELSE
    RAISE EXCEPTION 'Unknown drilldown kind: %', p_kind;
  END IF;

  RETURN jsonb_build_object('kind', p_kind, 'key', p_key, 'rows', v_rows);
END;
$function$;
