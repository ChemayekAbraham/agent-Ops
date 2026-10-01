CREATE TABLE public.fin_correction_review_items (
  collection_id uuid PRIMARY KEY,
  priority_group smallint NOT NULL CHECK (priority_group BETWEEN 1 AND 4),
  rent_plan_id uuid,
  tenant_name text,
  agent_name text,
  collected_at timestamptz,
  collection_amount numeric NOT NULL DEFAULT 0,
  rent_plan_amount numeric NOT NULL DEFAULT 0,
  cash_in_transit numeric NOT NULL DEFAULT 0,
  principal_recovered numeric NOT NULL DEFAULT 0,
  access_fee numeric NOT NULL DEFAULT 0,
  registration_fee numeric NOT NULL DEFAULT 0,
  platform_fee numeric NOT NULL DEFAULT 0,
  agent_commission numeric NOT NULL DEFAULT 0,
  recruiter_commission numeric NOT NULL DEFAULT 0,
  plan_status text,
  completion_dependent boolean NOT NULL DEFAULT false,
  original_classification text NOT NULL CHECK (original_classification IN ('Indeterminate','Unsupported')),
  evidence_state text NOT NULL DEFAULT 'Evidence not requested' CHECK (evidence_state IN ('Evidence not requested','Evidence requested','Evidence received','Confirmed Genuine','Confirmed Duplicate','Unresolved')),
  finance_classification text NOT NULL DEFAULT 'Unresolved' CHECK (finance_classification IN ('Confirmed Genuine','Confirmed Duplicate','Unresolved')),
  reviewer_name text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.fin_correction_review_items IS 'Evidence-review metadata for the 659 float-gate collections. Read-only snapshot of exposure; never drives money movement.';
GRANT SELECT ON public.fin_correction_review_items TO authenticated;
GRANT ALL ON public.fin_correction_review_items TO service_role;
ALTER TABLE public.fin_correction_review_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO approvers read review items" ON public.fin_correction_review_items FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));

CREATE OR REPLACE FUNCTION public.fin_correction_review_items_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Evidence review items cannot be deleted'; END IF;
  IF NEW.original_classification IS DISTINCT FROM OLD.original_classification
     OR NEW.collection_amount IS DISTINCT FROM OLD.collection_amount
     OR NEW.collection_id IS DISTINCT FROM OLD.collection_id THEN
    RAISE EXCEPTION 'Original classification and collection amount are immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_fin_correction_review_items_guard BEFORE UPDATE OR DELETE ON public.fin_correction_review_items FOR EACH ROW EXECUTE FUNCTION public.fin_correction_review_items_guard();

CREATE TABLE public.fin_correction_approval_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_ref text NOT NULL UNIQUE,
  collection_ids uuid[] NOT NULL,
  collection_count integer NOT NULL,
  amount numeric NOT NULL,
  impact jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('approval_prepared','rejected')),
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  decision_note text NOT NULL CHECK (length(btrim(decision_note)) >= 10),
  execution_status text NOT NULL DEFAULT 'not_executed' CHECK (execution_status = 'not_executed'),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.fin_correction_approval_batches IS 'CFO approval state only. Execution is not implemented; execution_status is constrained to not_executed.';
GRANT SELECT ON public.fin_correction_approval_batches TO authenticated;
GRANT ALL ON public.fin_correction_approval_batches TO service_role;
ALTER TABLE public.fin_correction_approval_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO approvers read approval batches" ON public.fin_correction_approval_batches FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));

CREATE OR REPLACE FUNCTION public.fin_correction_batches_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Approval batches are append-only'; END $$;
CREATE TRIGGER trg_fin_correction_batches_immutable BEFORE UPDATE OR DELETE ON public.fin_correction_approval_batches FOR EACH ROW EXECUTE FUNCTION public.fin_correction_batches_immutable();

CREATE OR REPLACE FUNCTION public.cfo_correction_center_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r jsonb;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  WITH i AS (SELECT * FROM public.fin_correction_review_items),
  batched AS (SELECT DISTINCT unnest(collection_ids) cid FROM public.fin_correction_approval_batches),
  agg AS (
    SELECT s.name, s.f,
      count(*) FILTER (WHERE s.f) cnt
    FROM (VALUES ('x',true)) s(name,f)
    GROUP BY 1,2)
  SELECT jsonb_build_object(
    'total', jsonb_build_object('count', (SELECT count(*) FROM i), 'amount', (SELECT coalesce(sum(collection_amount),0) FROM i),
       'indeterminate', (SELECT count(*) FROM i WHERE original_classification='Indeterminate'),
       'unsupported', (SELECT count(*) FROM i WHERE original_classification='Unsupported')),
    'by_state', (SELECT coalesce(jsonb_object_agg(evidence_state, jsonb_build_object('count',c,'amount',a)),'{}') FROM (SELECT evidence_state, count(*) c, sum(collection_amount) a FROM i GROUP BY 1) q),
    'by_classification', (SELECT coalesce(jsonb_object_agg(finance_classification, jsonb_build_object('count',c,'amount',a)),'{}') FROM (SELECT finance_classification, count(*) c, sum(collection_amount) a FROM i GROUP BY 1) q),
    'by_priority', (SELECT coalesce(jsonb_agg(jsonb_build_object('group',priority_group,'count',c,'amount',a,'awaiting',w) ORDER BY priority_group),'[]') FROM (SELECT priority_group, count(*) c, sum(collection_amount) a, count(*) FILTER (WHERE evidence_state IN ('Evidence not requested','Evidence requested')) w FROM i GROUP BY 1) q),
    'scenarios', (SELECT jsonb_agg(jsonb_build_object('scenario',sc,'collections',count(i.collection_id),'amount',coalesce(sum(collection_amount),0),'rent_plans',count(DISTINCT rent_plan_id),
         'completion_dependent',count(*) FILTER (WHERE completion_dependent AND i.collection_id IS NOT NULL),
         'cash_in_transit',coalesce(sum(cash_in_transit),0),'rent_plan_repayment',coalesce(sum(rent_plan_amount),0),'principal_recovered',coalesce(sum(principal_recovered),0),
         'access_fee',coalesce(sum(access_fee),0),'registration_fee',coalesce(sum(registration_fee),0),'platform_fee',coalesce(sum(platform_fee),0),
         'agent_commission',coalesce(sum(agent_commission),0),'recruiter_commission',coalesce(sum(recruiter_commission),0)) ORDER BY sc)
       FROM (VALUES ('A'),('B'),('C')) s(sc) LEFT JOIN i ON (s.sc='B' AND i.finance_classification='Confirmed Duplicate') OR (s.sc='C' AND i.finance_classification IN ('Confirmed Duplicate','Unresolved'))
       GROUP BY sc),
    'pending_approval', (SELECT jsonb_build_object('count',count(*),'amount',coalesce(sum(collection_amount),0),'rent_plans',count(DISTINCT rent_plan_id),
         'cash_in_transit',coalesce(sum(cash_in_transit),0),'rent_plan_repayment',coalesce(sum(rent_plan_amount),0),'principal_recovered',coalesce(sum(principal_recovered),0),
         'platform_fee',coalesce(sum(platform_fee),0),'agent_commission',coalesce(sum(agent_commission),0),'recruiter_commission',coalesce(sum(recruiter_commission),0))
       FROM i WHERE finance_classification='Confirmed Duplicate' AND collection_id NOT IN (SELECT cid FROM batched)),
    'last_review_at', (SELECT max(reviewed_at) FROM i)
  ) INTO r;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.cfo_correction_center_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_correction_center_summary() TO authenticated;

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
  VALUES (auth.uid(),'cfo_correction_'||st,'fin_correction_approval_batches',bid::text,btrim(p_note),jsonb_build_object('batch_ref',ref,'collections',n,'amount',amt,'executed',false));
  INSERT INTO public.system_events(event_type, metadata)
  SELECT 'report_generation_failed'::system_event_type, NULL WHERE false;
  RETURN jsonb_build_object('batch_id',bid,'batch_ref',ref,'status',st,'collections',n,'amount',amt,'executed',false);
END $$;
REVOKE ALL ON FUNCTION public.cfo_prepare_correction_decision(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_prepare_correction_decision(text,text) TO authenticated;