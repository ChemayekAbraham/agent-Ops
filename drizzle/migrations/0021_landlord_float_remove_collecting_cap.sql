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