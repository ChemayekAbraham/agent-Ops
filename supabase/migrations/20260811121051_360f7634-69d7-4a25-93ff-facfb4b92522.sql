CREATE OR REPLACE FUNCTION public.get_rent_disbursement_report(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb := '[]'::jsonb;
  v_count int := 0;
  v_total numeric := 0;
  v_methods jsonb := '[]'::jsonb;
  v_statuses jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
    has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
    OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin') OR has_role(v_uid,'financial_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view rent disbursement reports';
  END IF;

  WITH d AS (
    SELECT gl.id, gl.amount, gl.transaction_date, gl.source_id AS rent_request_id,
           gl.user_id AS tenant_id,
           gl.linked_party AS landlord_ref,
           CASE WHEN gl.linked_party ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN gl.linked_party::uuid END AS landlord_uuid,
           gl.description,
           gl.transaction_group_id
    FROM general_ledger gl
    WHERE gl.category = 'rent_disbursement'
      AND gl.ledger_scope = 'platform'
      AND gl.direction = 'cash_out'
      AND gl.classification <> 'admin_correction'
      AND gl.transaction_date >= p_start
      AND gl.transaction_date < p_end
  ), j AS (
    SELECT d.*,
      COALESCE(pt.full_name,'Unknown tenant') AS tenant_name,
      NULLIF(pt.phone,'') AS tenant_phone,
      COALESCE(l.name, NULLIF(d.landlord_ref,''),'—') AS landlord_name,
      NULLIF(l.phone,'') AS landlord_phone,
      rr.status AS request_status,
      rr.payout_method,
      rr.payout_transaction_reference,
      rr.rent_amount,
      rr.daily_repayment,
      rr.duration_days,
      rr.fund_recipient_type,
      rr.fund_recipient_name,
      rr.request_city,
      rr.request_country,
      COALESCE(pa.full_name,'—') AS agent_name,
      COALESCE(pb.full_name,'—') AS disbursed_by_name,
      hl.title AS property_title,
      hl.district AS property_district,
      hl.village AS property_village,
      hl.address AS property_address,
      ROW_NUMBER() OVER (ORDER BY d.transaction_date) AS rn
    FROM d
    LEFT JOIN rent_requests rr ON rr.id = d.rent_request_id
    LEFT JOIN profiles pt ON pt.id = d.tenant_id
    LEFT JOIN landlords l ON l.id = d.landlord_uuid
    LEFT JOIN profiles pa ON pa.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
    LEFT JOIN profiles pb ON pb.id = rr.cfo_reviewed_by
    LEFT JOIN house_listings hl ON hl.id = rr.house_listing_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'n', rn,
           'ledger_id', id,
           'rent_request_id', rent_request_id,
           'tenant_id', tenant_id,
           'tenant_name', tenant_name,
           'tenant_phone', COALESCE(tenant_phone,'—'),
           'landlord_id', COALESCE(landlord_uuid::text, NULLIF(landlord_ref,'')),
           'landlord_name', landlord_name,
           'landlord_phone', COALESCE(landlord_phone,'—'),
           'agent_name', agent_name,
           'disbursed_by', disbursed_by_name,
           'amount', amount,
           'rent_amount', COALESCE(rent_amount,0),
           'daily_repayment', COALESCE(daily_repayment,0),
           'duration_days', COALESCE(duration_days,0),
           'payout_method', COALESCE(payout_method,'—'),
           'recipient_type', COALESCE(fund_recipient_type,'—'),
           'recipient_name', COALESCE(fund_recipient_name,'—'),
           'reference', COALESCE(NULLIF(payout_transaction_reference,''), transaction_group_id::text,'—'),
           'status', COALESCE(request_status,'unknown'),
           'location', NULLIF(concat_ws(', ', NULLIF(property_village,''), NULLIF(property_district,''), NULLIF(request_city,''), NULLIF(request_country,'')),''),
           'property', NULLIF(concat_ws(' — ', NULLIF(property_title,''), NULLIF(property_address,'')),''),
           'date_eat', to_char(transaction_date + interval '3 hours','YYYY-MM-DD'),
           'time_eat', to_char(transaction_date + interval '3 hours','HH24:MI'),
           'description', description
         ) ORDER BY rn), '[]'::jsonb),
         COUNT(*), COALESCE(SUM(amount),0)
    INTO v_rows, v_count, v_total
  FROM j;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb) INTO v_methods
  FROM (
    SELECT jsonb_build_object('label', COALESCE(r->>'payout_method','—'), 'count', COUNT(*), 'amount', SUM((r->>'amount')::numeric)) AS x
    FROM jsonb_array_elements(v_rows) r GROUP BY COALESCE(r->>'payout_method','—')
  ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::jsonb) INTO v_statuses
  FROM (
    SELECT jsonb_build_object('label', COALESCE(r->>'status','unknown'), 'count', COUNT(*), 'amount', SUM((r->>'amount')::numeric)) AS x
    FROM jsonb_array_elements(v_rows) r GROUP BY COALESCE(r->>'status','unknown')
  ) s;

  RETURN jsonb_build_object(
    'period', jsonb_build_object(
      'start', p_start, 'end', p_end,
      'start_eat', to_char(p_start + interval '3 hours','YYYY-MM-DD HH24:MI'),
      'end_eat', to_char(p_end + interval '3 hours','YYYY-MM-DD HH24:MI')
    ),
    'generated_at', now(),
    'summary', jsonb_build_object(
      'disbursements_count', v_count,
      'total_amount', v_total,
      'tenants_count', (SELECT COUNT(DISTINCT r->>'tenant_id') FROM jsonb_array_elements(v_rows) r),
      'landlords_count', (SELECT COUNT(DISTINCT r->>'landlord_id') FROM jsonb_array_elements(v_rows) r)
    ),
    'rows', v_rows,
    'by_method', v_methods,
    'by_status', v_statuses
  );
END;
$function$;