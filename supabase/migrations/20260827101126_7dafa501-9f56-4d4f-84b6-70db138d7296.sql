CREATE OR REPLACE FUNCTION public.get_agent_ops_comprehensive_report(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_from date:=LEAST(p_from,p_to); v_to date:=GREATEST(p_from,p_to); v_start timestamptz; v_end timestamptz; v_days integer; v_result jsonb;
BEGIN
 IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'Not authorized to view the Agent Operations report'; END IF;
 IF v_from IS NULL OR v_to IS NULL THEN RAISE EXCEPTION 'A valid report date range is required'; END IF;
 IF v_to-v_from>366 THEN RAISE EXCEPTION 'Report range cannot exceed 367 days'; END IF;
 v_start:=v_from::timestamp AT TIME ZONE 'Africa/Kampala'; v_end:=(v_to+1)::timestamp AT TIME ZONE 'Africa/Kampala'; v_days:=(v_to-v_from)+1;
 WITH rent_agents AS (
   SELECT DISTINCT COALESCE(assigned_agent_id,agent_id) agent_id FROM public.rent_requests WHERE COALESCE(assigned_agent_id,agent_id) IS NOT NULL
 ), sub_agents AS (
   SELECT DISTINCT sub_agent_id agent_id FROM public.agent_subagents WHERE sub_agent_id IS NOT NULL AND COALESCE(status,'')<>'rejected'
 ), all_agents AS (
   SELECT agent_id FROM rent_agents UNION SELECT agent_id FROM sub_agents
 ), active_plans AS (
   SELECT id,tenant_id,COALESCE(assigned_agent_id,agent_id) agent_id,COALESCE(daily_repayment,0)::numeric daily_repayment,
     GREATEST(COALESCE(total_repayment,0)-COALESCE(amount_repaid,0),0)::numeric outstanding
   FROM public.rent_requests WHERE status IN ('funded','repaying') AND COALESCE(tenancy_status,'')<>'ended' AND COALESCE(assigned_agent_id,agent_id) IS NOT NULL
 ), collections AS (
   SELECT id,agent_id,tenant_id,amount::numeric,(created_at AT TIME ZONE 'Africa/Kampala')::date report_day
   FROM public.agent_collections WHERE created_at>=v_start AND created_at<v_end
 ), collected_by_tenant AS (
   SELECT tenant_id,sum(amount)::numeric collected FROM collections WHERE tenant_id IS NOT NULL GROUP BY tenant_id
 ), agent_collection_agg AS (
   SELECT agent_id,sum(amount)::numeric collected,count(DISTINCT tenant_id)::integer tenants_paid FROM collections GROUP BY agent_id
 ), agent_plan_agg AS (
   SELECT agent_id,sum(daily_repayment)::numeric*v_days expected,count(DISTINCT tenant_id)::integer active_tenants FROM active_plans GROUP BY agent_id
 ), agent_rent_named AS (
   SELECT aa.agent_id,COALESCE(NULLIF(p.full_name,''),'Unknown agent') agent_name,COALESCE(c.collected,0)::numeric collected,
     COALESCE(a.expected,0)::numeric expected,GREATEST(COALESCE(a.expected,0)-COALESCE(c.collected,0),0)::numeric missed,
     COALESCE(c.tenants_paid,0)::integer tenants_paid,COALESCE(a.active_tenants,0)::integer active_tenants,
     CASE WHEN COALESCE(a.expected,0)>0 THEN round(LEAST(COALESCE(c.collected,0)/a.expected*100,100),1) ELSE 0 END success_rate
   FROM all_agents aa LEFT JOIN agent_collection_agg c ON c.agent_id=aa.agent_id LEFT JOIN agent_plan_agg a ON a.agent_id=aa.agent_id LEFT JOIN public.profiles p ON p.id=aa.agent_id
 ), rent_daily AS (
   SELECT d::date report_day,COALESCE((SELECT sum(c.amount) FROM collections c WHERE c.report_day=d::date),0)::numeric collected,
     COALESCE((SELECT sum(ap.daily_repayment) FROM active_plans ap),0)::numeric expected
   FROM generate_series(v_from::timestamp,v_to::timestamp,interval '1 day') d
 ), advance_base AS (
   SELECT a.*,COALESCE(a.principal,0)+COALESCE(a.access_fee,0) total_due,GREATEST(COALESCE(a.principal,0)+COALESCE(a.access_fee,0)-COALESCE(a.outstanding_balance,0),0) recovered,
     public.advance_expected_repaid_to_date(a.issued_at,a.principal,a.access_fee,a.cycle_days,a.repayment_frequency,a.installment_amount) expected_recovered
   FROM public.agent_advances a
 ), advance_agent AS (
   SELECT a.agent_id,COALESCE(NULLIF(p.full_name,''),'Unknown agent') agent_name,sum(a.recovered)::numeric recovered,sum(a.outstanding_balance)::numeric outstanding,
     sum(GREATEST(a.expected_recovered-a.recovered,0))::numeric missed,bool_or(a.status='overdue' OR a.expires_at<now()) overdue
   FROM advance_base a LEFT JOIN public.profiles p ON p.id=a.agent_id WHERE a.status IN ('active','overdue','completed') GROUP BY a.agent_id,p.full_name
 ), advance_daily AS (
   SELECT d::date report_day,COALESCE((SELECT sum(l.amount_deducted) FROM public.agent_advance_ledger l WHERE l.date=d::date),0)::numeric recovered,
     COALESCE((SELECT sum(GREATEST(ab.expected_recovered-ab.recovered,0)) FROM advance_base ab WHERE (ab.issued_at AT TIME ZONE 'Africa/Kampala')::date<=d::date AND ab.status IN ('active','overdue')),0)::numeric missed
   FROM generate_series(v_from::timestamp,v_to::timestamp,interval '1 day') d
 ), centre_agents AS (
   SELECT e.id,COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id',p.id,'name',COALESCE(NULLIF(p.full_name,''),'Unknown agent'),'phone',COALESCE(p.phone,''))) FILTER(WHERE p.id IS NOT NULL),'[]'::jsonb) agents
   FROM public.service_centre_entries e LEFT JOIN LATERAL (
     SELECT x.agent_id FROM public.service_centre_agent_assignments x WHERE x.service_centre_id=e.id AND x.status='active'
     UNION SELECT unnest(COALESCE(e.assigned_agent_ids,'{}'::uuid[]))
   ) a ON true LEFT JOIN public.profiles p ON p.id=a.agent_id GROUP BY e.id
 ), centre_rows AS (
   SELECT e.id,e.stationed_location,e.status,e.created_at,e.forecast_amount,e.unit_price,COALESCE(ca.agents,'[]'::jsonb) agents,
     COALESCE(r.total_repayable,0)::numeric receivable,COALESCE(r.recoverable_amount,0)::numeric remaining,GREATEST(COALESCE(r.total_repayable,0)-COALESCE(r.recoverable_amount,0),0)::numeric repaid
   FROM public.service_centre_entries e LEFT JOIN centre_agents ca ON ca.id=e.id LEFT JOIN LATERAL (
     SELECT sum(sr.total_repayable) total_repayable,sum(sr.recoverable_amount) recoverable_amount FROM public.service_centre_receivables sr WHERE sr.service_centre_id=e.id AND sr.status<>'cancelled'
   ) r ON true
 ), new_requests AS (
   SELECT count(*)::integer count,COALESCE(sum(rent_amount),0)::numeric volume FROM public.rent_requests WHERE created_at>=v_start AND created_at<v_end
 ), products AS (SELECT public.get_agent_products_services_report(v_to,v_from) payload)
 SELECT jsonb_build_object(
  'generated_at',now(),'timezone','Africa/Kampala','from',v_from,'to',v_to,'days',v_days,
  'overview',jsonb_build_object('all_agents',(SELECT count(*) FROM all_agents),'agents',(SELECT count(*) FROM rent_agents),'sub_agents',(SELECT count(*) FROM sub_agents),'collected',(SELECT COALESCE(sum(amount),0) FROM collections),'pending',(SELECT COALESCE(sum(outstanding),0) FROM active_plans),'tenants_paid',(SELECT count(DISTINCT tenant_id) FROM collections WHERE tenant_id IS NOT NULL),'tenants_not_collected',(SELECT count(DISTINCT ap.tenant_id) FROM active_plans ap LEFT JOIN collected_by_tenant cb ON cb.tenant_id=ap.tenant_id WHERE cb.tenant_id IS NULL)),
  'rent',jsonb_build_object('collected',(SELECT COALESCE(sum(amount),0) FROM collections),'expected',(SELECT COALESCE(sum(daily_repayment),0)*v_days FROM active_plans),'missed',GREATEST((SELECT COALESCE(sum(daily_repayment),0)*v_days FROM active_plans)-(SELECT COALESCE(sum(amount),0) FROM collections),0),'new_requests',(SELECT count FROM new_requests),'new_request_volume',(SELECT volume FROM new_requests),'agents',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.collected DESC,x.agent_name) FROM agent_rent_named x WHERE x.expected>0 OR x.collected>0),'[]'::jsonb),'daily',COALESCE((SELECT jsonb_agg(jsonb_build_object('day',report_day,'collected',collected,'expected',expected,'missed',GREATEST(expected-collected,0)) ORDER BY report_day) FROM rent_daily),'[]'::jsonb),'top_paying',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM agent_rent_named WHERE expected>0 ORDER BY success_rate DESC,collected DESC LIMIT 5)x),'[]'::jsonb),'top_missed',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM agent_rent_named WHERE missed>0 ORDER BY missed DESC LIMIT 5)x),'[]'::jsonb)),
  'advances',jsonb_build_object('total_volume',(SELECT COALESCE(sum(principal),0) FROM advance_base),'pending',(SELECT count(*) FROM public.agent_advance_requests WHERE status IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved')),'approved',(SELECT count(*) FROM public.agent_advance_requests WHERE status IN ('cfo_paid','approved')),'repaying',(SELECT count(*) FROM advance_base WHERE status='active'),'overdue',(SELECT count(*) FROM advance_base WHERE status='overdue'),'repaid',(SELECT COALESCE(sum(recovered),0) FROM advance_base),'agents',(SELECT count(DISTINCT agent_id) FROM advance_base WHERE status IN ('active','overdue','completed')),'recovery_rate',(SELECT CASE WHEN COALESCE(sum(total_due),0)>0 THEN round(sum(recovered)/sum(total_due)*100,1) ELSE 0 END FROM advance_base),'daily',COALESCE((SELECT jsonb_agg(jsonb_build_object('day',report_day,'recovered',recovered,'missed',missed) ORDER BY report_day) FROM advance_daily),'[]'::jsonb),'top_paying',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM advance_agent ORDER BY recovered DESC LIMIT 5)x),'[]'::jsonb),'top_overdue',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM advance_agent WHERE overdue ORDER BY outstanding DESC LIMIT 5)x),'[]'::jsonb)),
  'service_centres',jsonb_build_object('all',(SELECT count(*) FROM centre_rows),'pending',(SELECT count(*) FROM centre_rows WHERE status LIKE 'pending%'),'approved',(SELECT count(*) FROM centre_rows WHERE status='verified'),'rejected',(SELECT count(*) FROM centre_rows WHERE status='rejected'),'approved_volume',(SELECT COALESCE(sum(COALESCE(forecast_amount,unit_price,0)),0) FROM centre_rows WHERE status='verified'),'receivables',(SELECT COALESCE(sum(receivable),0) FROM centre_rows),'repayments',(SELECT COALESCE(sum(repaid),0) FROM centre_rows),'rows',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM centre_rows x WHERE x.status='verified'),'[]'::jsonb)),
  'products',(SELECT payload FROM products),'performance',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.success_rate DESC,x.collected DESC) FROM (SELECT * FROM agent_rent_named WHERE expected>0 OR collected>0 ORDER BY success_rate DESC,collected DESC LIMIT 20)x),'[]'::jsonb)
 ) INTO v_result;
 RETURN v_result;
END;$function$;
REVOKE ALL ON FUNCTION public.get_agent_ops_comprehensive_report(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_comprehensive_report(date,date) TO authenticated,service_role;