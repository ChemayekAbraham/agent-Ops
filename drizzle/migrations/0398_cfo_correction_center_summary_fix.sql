CREATE OR REPLACE FUNCTION public.cfo_correction_center_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r jsonb;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  WITH i AS (SELECT * FROM public.fin_correction_review_items),
  batched AS (SELECT DISTINCT unnest(collection_ids) cid FROM public.fin_correction_approval_batches),
  sc AS (
    SELECT s.sc, jsonb_build_object('scenario',s.sc,'collections',count(i.collection_id),'amount',coalesce(sum(collection_amount),0),'rent_plans',count(DISTINCT rent_plan_id),
         'completion_dependent',count(*) FILTER (WHERE completion_dependent),
         'cash_in_transit',coalesce(sum(cash_in_transit),0),'rent_plan_repayment',coalesce(sum(rent_plan_amount),0),'principal_recovered',coalesce(sum(principal_recovered),0),
         'access_fee',coalesce(sum(access_fee),0),'registration_fee',coalesce(sum(registration_fee),0),'platform_fee',coalesce(sum(platform_fee),0),
         'agent_commission',coalesce(sum(agent_commission),0),'recruiter_commission',coalesce(sum(recruiter_commission),0)) j
    FROM (VALUES ('A'),('B'),('C')) s(sc)
    LEFT JOIN i ON (s.sc='B' AND i.finance_classification='Confirmed Duplicate') OR (s.sc='C' AND i.finance_classification IN ('Confirmed Duplicate','Unresolved'))
    GROUP BY s.sc)
  SELECT jsonb_build_object(
    'total', jsonb_build_object('count', (SELECT count(*) FROM i), 'amount', (SELECT coalesce(sum(collection_amount),0) FROM i),
       'indeterminate', (SELECT count(*) FROM i WHERE original_classification='Indeterminate'),
       'unsupported', (SELECT count(*) FROM i WHERE original_classification='Unsupported')),
    'by_state', (SELECT coalesce(jsonb_object_agg(evidence_state, jsonb_build_object('count',c,'amount',a)),'{}') FROM (SELECT evidence_state, count(*) c, sum(collection_amount) a FROM i GROUP BY 1) q),
    'by_classification', (SELECT coalesce(jsonb_object_agg(finance_classification, jsonb_build_object('count',c,'amount',a)),'{}') FROM (SELECT finance_classification, count(*) c, sum(collection_amount) a FROM i GROUP BY 1) q),
    'by_priority', (SELECT coalesce(jsonb_agg(jsonb_build_object('group',priority_group,'count',c,'amount',a,'awaiting',w) ORDER BY priority_group),'[]') FROM (SELECT priority_group, count(*) c, sum(collection_amount) a, count(*) FILTER (WHERE evidence_state IN ('Evidence not requested','Evidence requested')) w FROM i GROUP BY 1) q),
    'scenarios', (SELECT jsonb_agg(j ORDER BY sc) FROM sc),
    'pending_approval', (SELECT jsonb_build_object('count',count(*),'amount',coalesce(sum(collection_amount),0),'rent_plans',count(DISTINCT rent_plan_id),
         'cash_in_transit',coalesce(sum(cash_in_transit),0),'rent_plan_repayment',coalesce(sum(rent_plan_amount),0),'principal_recovered',coalesce(sum(principal_recovered),0),
         'platform_fee',coalesce(sum(platform_fee),0),'agent_commission',coalesce(sum(agent_commission),0),'recruiter_commission',coalesce(sum(recruiter_commission),0))
       FROM i WHERE finance_classification='Confirmed Duplicate' AND collection_id NOT IN (SELECT cid FROM batched)),
    'last_review_at', (SELECT max(reviewed_at) FROM i)
  ) INTO r;
  RETURN r;
END $$;