CREATE OR REPLACE FUNCTION public.cfo_save_evidence_review(p_collection_id uuid, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.fin_correction_review_items; n public.fin_correction_review_items; fl text[]; res text; st text; nm text;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO o FROM public.fin_correction_review_items WHERE collection_id = p_collection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review item not found'; END IF;
  IF o.collection_id IN (SELECT unnest(collection_ids) FROM public.fin_correction_approval_batches) THEN
    RAISE EXCEPTION 'This collection is already in a recorded CFO decision and can no longer be edited'; END IF;
  res := coalesce(nullif(p->>'finance_classification',''),'Unresolved');
  IF res NOT IN ('Confirmed Genuine','Confirmed Duplicate','Unresolved') THEN RAISE EXCEPTION 'Invalid Finance result'; END IF;
  fl := public.fin_correction_review_flags(p_collection_id, p);
  st := CASE WHEN res <> 'Unresolved' THEN res
             WHEN coalesce((p->>'evidence_received')::boolean,false) THEN 'Evidence received'
             WHEN coalesce((p->>'evidence_requested')::boolean,false) THEN 'Evidence requested'
             ELSE 'Evidence not requested' END;
  SELECT coalesce(full_name, 'Unknown') INTO nm FROM public.profiles WHERE id = auth.uid();
  UPDATE public.fin_correction_review_items SET
    evidence_requested = coalesce((p->>'evidence_requested')::boolean,false),
    evidence_requested_on = nullif(p->>'evidence_requested_on','')::date,
    evidence_received = coalesce((p->>'evidence_received')::boolean,false),
    evidence_type = nullif(p->>'evidence_type',''),
    evidence_reference = nullif(btrim(p->>'evidence_reference'),''),
    evidence_date = nullif(p->>'evidence_date','')::date,
    evidence_amount = nullif(p->>'evidence_amount','')::numeric,
    evidence_holder = nullif(btrim(p->>'evidence_holder'),''),
    evidence_location = nullif(btrim(p->>'evidence_location'),''),
    payment_channel = nullif(btrim(p->>'payment_channel'),''),
    payer_identity = nullif(btrim(p->>'payer_identity'),''),
    evidence_group_id = nullif(btrim(p->>'evidence_group_id'),''),
    shared_receipt_explanation = nullif(btrim(p->>'shared_receipt_explanation'),''),
    reviewer_notes = nullif(btrim(p->>'reviewer_notes'),''),
    finance_classification = res, evidence_state = st, review_flags = fl,
    reviewed_by = auth.uid(), reviewer_name = nm, reviewed_at = now()
  WHERE collection_id = p_collection_id RETURNING * INTO n;
  INSERT INTO public.fin_correction_review_audit(collection_id, reviewer_id, reviewer_name, previous_value, new_value, flags)
  VALUES (p_collection_id, auth.uid(), nm, to_jsonb(o), to_jsonb(n), fl);
  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 'evidence_review_saved', 'fin_correction_review_items', p_collection_id, 'Finance evidence review saved (review only, no financial correction)',
          jsonb_build_object('result', res, 'state', st, 'flags', fl, 'is_test', n.is_test));
  RETURN jsonb_build_object('item', to_jsonb(n), 'flags', fl);
END $$;

CREATE OR REPLACE FUNCTION public.cfo_correction_center_summary()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r jsonb;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  WITH i AS (SELECT * FROM public.fin_correction_review_items WHERE NOT is_test),
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
END $function$;

CREATE OR REPLACE FUNCTION public.cfo_prepare_correction_decision(p_decision text, p_note text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE ids uuid[]; n int; amt numeric; imp jsonb; ref text; bid uuid; st text;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'Decision must be approve or reject'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;
  SELECT array_agg(collection_id ORDER BY collection_id), count(*), coalesce(sum(collection_amount),0),
    jsonb_build_object('cash_in_transit',coalesce(sum(cash_in_transit),0),'rent_plan_repayment',coalesce(sum(rent_plan_amount),0),'principal_recovered',coalesce(sum(principal_recovered),0),'platform_fee',coalesce(sum(platform_fee),0),'agent_commission',coalesce(sum(agent_commission),0),'recruiter_commission',coalesce(sum(recruiter_commission),0))
  INTO ids, n, amt, imp
  FROM public.fin_correction_review_items
  WHERE finance_classification='Confirmed Duplicate' AND NOT is_test
    AND collection_id NOT IN (SELECT unnest(collection_ids) FROM public.fin_correction_approval_batches);
  IF n = 0 THEN RAISE EXCEPTION 'No Confirmed Duplicate collections are pending approval'; END IF;
  st := CASE WHEN p_decision='approve' THEN 'approval_prepared' ELSE 'rejected' END;
  ref := 'FGC-' || to_char(now() AT TIME ZONE 'Africa/Kampala','YYYYMMDD-HH24MISS');
  INSERT INTO public.fin_correction_approval_batches(batch_ref,collection_ids,collection_count,amount,impact,status,decided_by,decision_note)
  VALUES (ref,ids,n,amt,imp,st,auth.uid(),btrim(p_note)) RETURNING id INTO bid;
  INSERT INTO public.audit_logs(user_id,action_type,table_name,record_id,reason,metadata)
  VALUES (auth.uid(),'cfo_correction_'||st,'fin_correction_approval_batches',bid,btrim(p_note),jsonb_build_object('batch_ref',ref,'collections',n,'amount',amt,'executed',false));
  RETURN jsonb_build_object('batch_id',bid,'batch_ref',ref,'status',st,'collections',n,'amount',amt,'executed',false);
END $function$;