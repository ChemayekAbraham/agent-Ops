CREATE OR REPLACE FUNCTION public.cfo_prepare_correction_decision(p_decision text, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE ids uuid[]; n int; amt numeric; imp jsonb; ref text; bid uuid; st text;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'Decision must be approve or reject'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;
  SELECT array_agg(collection_id ORDER BY collection_id), count(*), coalesce(sum(collection_amount),0),
    jsonb_build_object('cash_in_transit',coalesce(sum(cash_in_transit),0),'rent_plan_repayment',coalesce(sum(rent_plan_amount),0),'principal_recovered',coalesce(sum(principal_recovered),0),'platform_fee',coalesce(sum(platform_fee),0),'agent_commission',coalesce(sum(agent_commission),0),'recruiter_commission',coalesce(sum(recruiter_commission),0))
  INTO ids, n, amt, imp
  FROM public.fin_correction_review_items
  WHERE finance_classification='Confirmed Duplicate'
    AND collection_id NOT IN (SELECT unnest(collection_ids) FROM public.fin_correction_approval_batches);
  IF n = 0 THEN RAISE EXCEPTION 'No Confirmed Duplicate collections are pending approval'; END IF;
  st := CASE WHEN p_decision='approve' THEN 'approval_prepared' ELSE 'rejected' END;
  ref := 'FGC-' || to_char(now() AT TIME ZONE 'Africa/Kampala','YYYYMMDD-HH24MISS');
  INSERT INTO public.fin_correction_approval_batches(batch_ref,collection_ids,collection_count,amount,impact,status,decided_by,decision_note)
  VALUES (ref,ids,n,amt,imp,st,auth.uid(),btrim(p_note)) RETURNING id INTO bid;
  INSERT INTO public.audit_logs(user_id,action_type,table_name,record_id,reason,metadata)
  VALUES (auth.uid(),'cfo_correction_'||st,'fin_correction_approval_batches',bid,btrim(p_note),jsonb_build_object('batch_ref',ref,'collections',n,'amount',amt,'executed',false));
  RETURN jsonb_build_object('batch_id',bid,'batch_ref',ref,'status',st,'collections',n,'amount',amt,'executed',false);
END $$;