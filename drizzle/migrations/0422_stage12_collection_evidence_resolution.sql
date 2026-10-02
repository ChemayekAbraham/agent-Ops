-- Stage 12: evidence resolution + correction preview. Investigation only; nothing here posts, reverses or edits financial records.
CREATE TABLE public.fin_collection_evidence_s12 (
  collection_id uuid PRIMARY KEY REFERENCES public.fin_collection_reconciliation_s11(collection_id),
  evidence_status text NOT NULL DEFAULT 'Pending Evidence' CHECK (evidence_status IN ('Pending Evidence','Confirmed Genuine','Confirmed Duplicate','Confirmed Agent Mismatch','Valid Separate Payment','Unresolved')),
  evidence_type text CHECK (evidence_type IS NULL OR evidence_type IN ('Agent receipt','Tenant confirmation','Cash handover record','Deposit/bank evidence','Mobile-money evidence','Other supporting evidence')),
  evidence_reference text, receipt_number text, evidence_date date, evidence_source text, notes text,
  attachment_path text,
  valid_original_id uuid, duplicate_of_id uuid, confirmed_agent_id uuid,
  correction_status text NOT NULL DEFAULT 'Not Ready' CHECK (correction_status IN ('Not Ready','Ready for CFO Review')),
  verified_by uuid, verified_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.fin_collection_evidence_s12 TO service_role;
ALTER TABLE public.fin_collection_evidence_s12 ENABLE ROW LEVEL SECURITY;

INSERT INTO public.fin_collection_evidence_s12 (collection_id) SELECT collection_id FROM public.fin_collection_reconciliation_s11;

CREATE TABLE public.fin_collection_evidence_s12_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL, actor uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  previous_status text, new_status text NOT NULL, reason text NOT NULL, evidence_reference text, notes text, details jsonb
);
GRANT ALL ON public.fin_collection_evidence_s12_audit TO service_role;
ALTER TABLE public.fin_collection_evidence_s12_audit ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fin_s12_population_lock() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Stage 11/12 population is fixed (659 collections); % not permitted', TG_OP; END $$;
CREATE TRIGGER trg_s12_no_insert_delete BEFORE INSERT OR DELETE ON public.fin_collection_evidence_s12 FOR EACH ROW EXECUTE FUNCTION public.fin_s12_population_lock();
CREATE TRIGGER trg_s11_frozen BEFORE INSERT OR UPDATE OR DELETE ON public.fin_collection_reconciliation_s11 FOR EACH ROW EXECUTE FUNCTION public.fin_s12_population_lock();
CREATE OR REPLACE FUNCTION public.fin_s12_audit_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Stage 12 audit is append-only'; END $$;
CREATE TRIGGER trg_s12_audit_append_only BEFORE UPDATE OR DELETE ON public.fin_collection_evidence_s12_audit FOR EACH ROW EXECUTE FUNCTION public.fin_s12_audit_append_only();

CREATE OR REPLACE FUNCTION public.cfo_s12_list()
RETURNS TABLE (collection_id uuid, collected_at timestamptz, agent_id uuid, agent_name text, tenant_name text, rent_plan_id uuid,
  plan_agent_id uuid, plan_agent_name text, amount numeric, original_classification text, reconciliation_result text,
  ledger_group text, ledger_receipt numeric, ledger_repayment numeric, ledger_commission numeric, access_fee numeric, registration_fee numeric,
  reversed_at timestamptz, findings text, evidence jsonb, matches jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY
  SELECT s.collection_id, s.collected_at, s.agent_id, s.agent_name, s.tenant_name, s.rent_plan_id,
    rr.agent_id, pa.full_name, s.amount, s.original_classification, s.reconciliation_result,
    s.ledger_group, s.ledger_receipt, s.ledger_repayment, s.ledger_commission, s.access_fee, s.registration_fee,
    s.reversed_at, s.findings, to_jsonb(e) - 'collection_id',
    CASE WHEN s.dup_matches > 0 THEN (
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'collected_at', o.created_at, 'agent_id', o.agent_id, 'amount', o.amount,
        'seconds_apart', round(extract(epoch FROM o.created_at - s.collected_at)), 'reversed_at', o.reversed_at,
        'in_population', EXISTS (SELECT 1 FROM public.fin_collection_reconciliation_s11 x WHERE x.collection_id = o.id)) ORDER BY o.created_at)
      FROM public.agent_collections o
      WHERE o.id <> s.collection_id AND o.agent_id = s.agent_id AND o.tenant_id IS NOT DISTINCT FROM s.tenant_id
        AND o.rent_request_id IS NOT DISTINCT FROM s.rent_plan_id AND o.amount = s.amount
        AND abs(extract(epoch FROM o.created_at - s.collected_at)) <= 1800) END
  FROM public.fin_collection_reconciliation_s11 s
  JOIN public.fin_collection_evidence_s12 e ON e.collection_id = s.collection_id
  LEFT JOIN public.rent_requests rr ON rr.id = s.rent_plan_id
  LEFT JOIN public.profiles pa ON pa.id = rr.agent_id
  ORDER BY s.collected_at;
END $$;

CREATE OR REPLACE FUNCTION public.cfo_s12_save_evidence(p_collection_id uuid, p_status text, p_reason text, p_fields jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prev text; v_orig uuid; v_agent uuid; v_ready text;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF length(coalesce(trim(p_reason),'')) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;
  SELECT evidence_status INTO v_prev FROM public.fin_collection_evidence_s12 WHERE collection_id = p_collection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Collection is not in the Stage 11 population'; END IF;
  v_orig := nullif(p_fields->>'valid_original_id','')::uuid;
  v_agent := nullif(p_fields->>'confirmed_agent_id','')::uuid;
  IF p_status IN ('Confirmed Genuine','Confirmed Duplicate','Confirmed Agent Mismatch','Valid Separate Payment')
     AND nullif(p_fields->>'evidence_type','') IS NULL THEN
    RAISE EXCEPTION 'A confirmed status needs an evidence type';
  END IF;
  IF p_status = 'Confirmed Duplicate' THEN
    IF v_orig IS NULL OR v_orig = p_collection_id THEN RAISE EXCEPTION 'Name the valid original collection (a different collection)'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.agent_collections WHERE id = v_orig) THEN RAISE EXCEPTION 'Original collection not found'; END IF;
  ELSE v_orig := NULL; END IF;
  IF p_status = 'Confirmed Agent Mismatch' THEN
    IF v_agent IS NULL THEN RAISE EXCEPTION 'Name the confirmed collecting agent'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_agent) THEN RAISE EXCEPTION 'Confirmed agent not found'; END IF;
  ELSE v_agent := NULL; END IF;
  v_ready := CASE WHEN p_status IN ('Confirmed Duplicate','Confirmed Agent Mismatch') THEN 'Ready for CFO Review' ELSE 'Not Ready' END;

  UPDATE public.fin_collection_evidence_s12 SET
    evidence_status = p_status,
    evidence_type = nullif(p_fields->>'evidence_type',''),
    evidence_reference = nullif(p_fields->>'evidence_reference',''),
    receipt_number = nullif(p_fields->>'receipt_number',''),
    evidence_date = nullif(p_fields->>'evidence_date','')::date,
    evidence_source = nullif(p_fields->>'evidence_source',''),
    notes = nullif(p_fields->>'notes',''),
    attachment_path = coalesce(nullif(p_fields->>'attachment_path',''), attachment_path),
    valid_original_id = v_orig, duplicate_of_id = CASE WHEN v_orig IS NULL THEN NULL ELSE p_collection_id END,
    confirmed_agent_id = v_agent, correction_status = v_ready,
    verified_by = auth.uid(), verified_at = now(), updated_at = now()
  WHERE collection_id = p_collection_id;

  INSERT INTO public.fin_collection_evidence_s12_audit (collection_id, actor, previous_status, new_status, reason, evidence_reference, notes, details)
  VALUES (p_collection_id, auth.uid(), v_prev, p_status, trim(p_reason), nullif(p_fields->>'evidence_reference',''), nullif(p_fields->>'notes',''), p_fields);
END $$;

CREATE OR REPLACE FUNCTION public.cfo_s12_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r jsonb; n int; a numeric;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT count(*), coalesce(sum(s.amount),0) INTO n, a FROM public.fin_collection_evidence_s12 e JOIN public.fin_collection_reconciliation_s11 s USING (collection_id);
  SELECT jsonb_build_object(
    'population', n, 'amount', a, 'balanced', (n = 659 AND a = 56946270),
    'by_status', (SELECT jsonb_object_agg(evidence_status, jsonb_build_object('count', c, 'amount', t)) FROM (
       SELECT e.evidence_status, count(*) c, sum(s.amount) t FROM public.fin_collection_evidence_s12 e JOIN public.fin_collection_reconciliation_s11 s USING (collection_id) GROUP BY 1) x),
    'correction_ready', (SELECT jsonb_build_object('count', count(*), 'amount', coalesce(sum(s.amount),0)) FROM public.fin_collection_evidence_s12 e JOIN public.fin_collection_reconciliation_s11 s USING (collection_id) WHERE e.correction_status = 'Ready for CFO Review'))
  INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.cfo_s12_audit(p_collection_id uuid)
RETURNS SETOF public.fin_collection_evidence_s12_audit LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY SELECT * FROM public.fin_collection_evidence_s12_audit WHERE collection_id = p_collection_id ORDER BY created_at DESC;
END $$;

REVOKE ALL ON FUNCTION public.cfo_s12_list(), public.cfo_s12_save_evidence(uuid,text,text,jsonb), public.cfo_s12_summary(), public.cfo_s12_audit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_s12_list(), public.cfo_s12_save_evidence(uuid,text,text,jsonb), public.cfo_s12_summary(), public.cfo_s12_audit(uuid) TO authenticated;

CREATE POLICY "CFO approvers read collection evidence" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'collection-evidence' AND public.is_cfo_approver(auth.uid()));
CREATE POLICY "CFO approvers upload collection evidence" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'collection-evidence' AND public.is_cfo_approver(auth.uid()));