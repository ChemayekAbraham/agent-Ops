CREATE OR REPLACE FUNCTION public.landlord_ops_float_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_needed_empty jsonb;
  v_needed_waiting jsonb;
  v_empty_rows jsonb;
  v_waiting_rows jsonb;
  v_paid jsonb;
  v_paid_all_time jsonb;
  v_expected jsonb;
  v_collect_rows jsonb;
  v_agents jsonb;
  v_agent_rows jsonb;
  v_portfolios jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       public.is_ops_role(v_uid)
       OR has_role(v_uid,'landlord_ops') OR has_role(v_uid,'tenant_ops')
       OR has_role(v_uid,'agent_ops') OR has_role(v_uid,'operations')
       OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'cfo') OR has_role(v_uid,'coo') OR has_role(v_uid,'ceo')
       OR has_role(v_uid,'cto') OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the landlord float overview';
  END IF;

  SELECT jsonb_build_object('houses', COUNT(*), 'amount', COALESCE(SUM(hl.monthly_rent),0))
  INTO v_needed_empty
  FROM house_listings hl
  WHERE hl.tenant_id IS NULL
    AND COALESCE(hl.is_hidden,false) = false
    AND hl.status = 'available';

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
  INTO v_empty_rows
  FROM (
    SELECT jsonb_build_object(
             'district', COALESCE(NULLIF(hl.district,''),'Unspecified'),
             'houses', COUNT(*),
             'amount', COALESCE(SUM(hl.monthly_rent),0)
           ) AS x
    FROM house_listings hl
    WHERE hl.tenant_id IS NULL
      AND COALESCE(hl.is_hidden,false) = false
      AND hl.status = 'available'
    GROUP BY COALESCE(NULLIF(hl.district,''),'Unspecified')
  ) s;

  SELECT jsonb_build_object('houses', COUNT(*), 'amount', COALESCE(SUM(rr.rent_amount),0))
  INTO v_needed_waiting
  FROM rent_requests rr
  WHERE rr.funded_at IS NULL
    AND rr.status IN ('pending','service_center_review','tenant_ops_approved','landlord_ops_approved','agent_ops_approved');

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
  INTO v_waiting_rows
  FROM (
    SELECT jsonb_build_object(
             'rent_request_id', rr.id,
             'tenant_name', COALESCE(tp.full_name,'Unnamed tenant'),
             'landlord_name', COALESCE(ld.name,'No landlord linked'),
             'landlord_phone', ld.phone,
             'district', COALESCE(NULLIF(ld.district,''), NULLIF(tp.district,''), 'Unspecified'),
             'status', rr.status,
             'amount', COALESCE(rr.rent_amount,0),
             'created_at', rr.created_at
           ) AS x
    FROM rent_requests rr
    LEFT JOIN profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN landlords ld ON ld.id = rr.landlord_id
    WHERE rr.funded_at IS NULL
      AND rr.status IN ('pending','service_center_review','tenant_ops_approved','landlord_ops_approved','agent_ops_approved')
    ORDER BY COALESCE(rr.rent_amount,0) DESC
    LIMIT 300
  ) s;

  SELECT jsonb_build_object('payouts', COUNT(*), 'amount', COALESCE(SUM(lp.amount),0))
  INTO v_paid
  FROM landlord_payouts lp
  WHERE lp.status = 'completed';

  -- Exact amount ever disbursed to landlords: the disbursement really
  -- happened (a disbursement timestamp exists) and the payout did not fail.
  -- This includes payouts still awaiting the agent's receipt confirmation.
  SELECT jsonb_build_object('payouts', COUNT(*), 'amount', COALESCE(SUM(lp.amount),0))
  INTO v_paid_all_time
  FROM landlord_payouts lp
  WHERE lp.status <> 'failed'
    AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) IS NOT NULL;

  SELECT jsonb_build_object(
           'plans', COUNT(*),
           'expected', COALESCE(SUM(GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0)),0),
           'collected', COALESCE(SUM(COALESCE(rr.amount_repaid,0)),0),
           'contracted', COALESCE(SUM(COALESCE(rr.total_repayment,0)),0)
         )
  INTO v_expected
  FROM rent_requests rr
  WHERE rr.status IN ('funded','repaying');

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'outstanding')::numeric DESC), '[]'::jsonb)
  INTO v_collect_rows
  FROM (
    SELECT jsonb_build_object(
             'rent_request_id', rr.id,
             'tenant_name', COALESCE(tp.full_name,'Unnamed tenant'),
             'landlord_name', COALESCE(ld.name,'No landlord linked'),
             'landlord_phone', COALESCE(ld.phone, ld.mobile_money_number),
             'rent_amount', COALESCE(rr.rent_amount,0),
             'contracted', COALESCE(rr.total_repayment,0),
             'collected', COALESCE(rr.amount_repaid,0),
             'outstanding', GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0),
             'daily_repayment', COALESCE(rr.daily_repayment,0),
             'status', rr.status,
             'funded_at', rr.funded_at
           ) AS x
    FROM rent_requests rr
    LEFT JOIN profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN landlords ld ON ld.id = rr.landlord_id
    WHERE rr.status IN ('funded','repaying')
    ORDER BY GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0) DESC
    LIMIT 300
  ) s;

  SELECT jsonb_build_object(
           'agents', COUNT(*),
           'amount', COALESCE(SUM(f.balance),0),
           'total_funded', COALESCE(SUM(f.total_funded),0),
           'total_paid_out', COALESCE(SUM(f.total_paid_out),0)
         )
  INTO v_agents
  FROM agent_landlord_float f
  WHERE COALESCE(f.balance,0) > 0;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'balance')::numeric DESC), '[]'::jsonb)
  INTO v_agent_rows
  FROM (
    SELECT jsonb_build_object(
             'agent_id', f.agent_id,
             'agent_name', COALESCE(p.full_name,'Unnamed agent'),
             'agent_phone', p.phone,
             'region', f.region,
             'balance', COALESCE(f.balance,0),
             'total_funded', COALESCE(f.total_funded,0),
             'total_paid_out', COALESCE(f.total_paid_out,0),
             'updated_at', f.updated_at
           ) AS x
    FROM agent_landlord_float f
    LEFT JOIN profiles p ON p.id = f.agent_id
    WHERE COALESCE(f.balance,0) > 0
    ORDER BY COALESCE(f.balance,0) DESC
    LIMIT 300
  ) s;

  WITH caps AS (
    SELECT COALESCE(SUM(ip.investment_amount),0) AS total,
           COUNT(*) AS portfolios
    FROM investor_portfolios ip
    WHERE ip.status IN ('active','locked')
  ), attached AS (
    SELECT COALESCE(SUM(psh.principal),0) AS amount, COUNT(*) AS houses
    FROM partner_supported_houses psh
    WHERE psh.status <> 'cancelled'
  )
  SELECT jsonb_build_object(
           'portfolios', c.portfolios,
           'total', c.total,
           'attached_amount', a.amount,
           'attached_houses', a.houses,
           'unattached', GREATEST(c.total - a.amount, 0)
         )
  INTO v_portfolios
  FROM caps c CROSS JOIN attached a;

  RETURN jsonb_build_object(
    'as_at', now(),
    'needed', jsonb_build_object(
      'empty_houses', v_needed_empty,
      'waiting_funding', v_needed_waiting,
      'total_amount', COALESCE((v_needed_empty->>'amount')::numeric,0) + COALESCE((v_needed_waiting->>'amount')::numeric,0),
      'total_houses', COALESCE((v_needed_empty->>'houses')::numeric,0) + COALESCE((v_needed_waiting->>'houses')::numeric,0),
      'by_district', v_empty_rows,
      'waiting_rows', v_waiting_rows
    ),
    'collecting', jsonb_build_object(
      'paid_out', v_paid,
      'paid_all_time', v_paid_all_time,
      'expected', v_expected,
      'rows', v_collect_rows
    ),
    'with_agents', jsonb_build_object(
      'summary', v_agents,
      'rows', v_agent_rows
    ),
    'no_tenant', v_portfolios
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_float_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_float_overview() TO authenticated;

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
       public.is_ops_role(auth.uid())
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

  ELSIF p_kind = 'needed_district' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'id', hl.id,
               'source', 'Empty house',
               'name', COALESCE(NULLIF(hl.title,''),'Untitled house'),
               'landlord_name', COALESCE(ld.name,'No landlord linked'),
               'landlord_phone', COALESCE(ld.phone, ld.mobile_money_number),
               'agent_name', ap.full_name,
               'sub_county', hl.sub_county,
               'village', hl.village,
               'amount', COALESCE(hl.monthly_rent,0),
               'created_at', hl.created_at
             ) AS x
      FROM house_listings hl
      LEFT JOIN landlords ld ON ld.id = hl.landlord_id
      LEFT JOIN profiles ap ON ap.id = hl.agent_id
      LEFT JOIN mv_ug_district_alias da
        ON da.norm_key = ug_norm_name(NULLIF(hl.district, ''))
      WHERE hl.tenant_id IS NULL
        AND COALESCE(hl.is_hidden,false) = false
        AND hl.status = 'available'
        AND COALESCE(da.district_name, NULLIF(TRIM(hl.district), ''), 'Unspecified') = p_key
      UNION ALL
      SELECT jsonb_build_object(
               'id', rr.id,
               'source', 'Awaiting funding',
               'name', COALESCE(tp.full_name,'Unnamed tenant'),
               'landlord_name', COALESCE(ld.name,'No landlord linked'),
               'landlord_phone', COALESCE(ld.phone, ld.mobile_money_number),
               'agent_name', ap.full_name,
               'sub_county', NULL,
               'village', NULL,
               'amount', COALESCE(rr.rent_amount,0),
               'created_at', rr.created_at
             ) AS x
      FROM rent_requests rr
      LEFT JOIN profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN landlords ld ON ld.id = rr.landlord_id
      LEFT JOIN profiles ap ON ap.id = rr.agent_id
      LEFT JOIN mv_ug_district_alias da
        ON da.norm_key = ug_norm_name(COALESCE(NULLIF(ld.district, ''), NULLIF(tp.district, '')))
      WHERE rr.funded_at IS NULL
        AND rr.status IN ('pending','service_center_review','tenant_ops_approved','landlord_ops_approved','agent_ops_approved')
        AND COALESCE(da.district_name, NULLIF(TRIM(COALESCE(NULLIF(ld.district,''), NULLIF(tp.district,''))), ''), 'Unspecified') = p_key
      ORDER BY 1 DESC
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

  ELSIF p_kind = 'payouts_all' THEN
    -- Every payout whose money actually reached the landlord, all time.
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'disbursed_at') DESC), '[]'::jsonb)
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
               'status', lp.status,
               'disbursed_at', COALESCE(lp.finops_disbursed_at, lp.disbursed_at),
               'created_at', lp.created_at
             ) AS x
      FROM landlord_payouts lp
      LEFT JOIN landlords ld ON ld.id = lp.landlord_id
      LEFT JOIN profiles tp ON tp.id = lp.tenant_id
      LEFT JOIN profiles ap ON ap.id = lp.agent_id
      WHERE lp.status <> 'failed'
        AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) IS NOT NULL
      ORDER BY COALESCE(lp.finops_disbursed_at, lp.disbursed_at) DESC
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

REVOKE ALL ON FUNCTION public.landlord_ops_float_drilldown(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_float_drilldown(text, text) TO authenticated;