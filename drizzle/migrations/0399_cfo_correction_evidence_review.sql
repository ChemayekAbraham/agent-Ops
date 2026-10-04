ALTER TABLE public.fin_correction_review_items
  ADD COLUMN IF NOT EXISTS tenant_phone text,
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evidence_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evidence_requested_on date,
  ADD COLUMN IF NOT EXISTS evidence_received boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evidence_type text,
  ADD COLUMN IF NOT EXISTS evidence_reference text,
  ADD COLUMN IF NOT EXISTS evidence_date date,
  ADD COLUMN IF NOT EXISTS evidence_amount numeric,
  ADD COLUMN IF NOT EXISTS evidence_holder text,
  ADD COLUMN IF NOT EXISTS evidence_location text,
  ADD COLUMN IF NOT EXISTS payment_channel text,
  ADD COLUMN IF NOT EXISTS payer_identity text,
  ADD COLUMN IF NOT EXISTS evidence_group_id text,
  ADD COLUMN IF NOT EXISTS shared_receipt_explanation text,
  ADD COLUMN IF NOT EXISTS reviewer_notes text,
  ADD COLUMN IF NOT EXISTS review_flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid;

ALTER TABLE public.fin_correction_review_items
  ADD CONSTRAINT fin_correction_review_items_evidence_type_check CHECK (evidence_type IS NULL OR evidence_type IN
   ('Cash receipt','Tenant confirmation','Agent mobile-money statement','Tenant mobile-money statement','Bank statement','Deposit record','Other independently verifiable evidence'));

CREATE TABLE public.fin_correction_review_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES public.fin_correction_review_items(collection_id),
  reviewer_id uuid,
  reviewer_name text,
  logged_at timestamptz NOT NULL DEFAULT now(),
  previous_value jsonb NOT NULL,
  new_value jsonb NOT NULL,
  flags text[] NOT NULL DEFAULT '{}'
);
GRANT SELECT ON public.fin_correction_review_audit TO authenticated;
GRANT ALL ON public.fin_correction_review_audit TO service_role;
ALTER TABLE public.fin_correction_review_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO approvers read review audit" ON public.fin_correction_review_audit
  FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));

CREATE OR REPLACE FUNCTION public.fin_correction_review_audit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Evidence review audit history is append-only'; END $$;
CREATE TRIGGER trg_fin_correction_review_audit_guard BEFORE UPDATE OR DELETE ON public.fin_correction_review_audit
  FOR EACH ROW EXECUTE FUNCTION public.fin_correction_review_audit_guard();

-- Matching checks: flag only, never reject.
CREATE OR REPLACE FUNCTION public.fin_correction_review_flags(p_collection_id uuid, p jsonb)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.fin_correction_review_items; f text[] := '{}'; amt numeric; grp_n int; ref text; d date;
BEGIN
  SELECT * INTO i FROM public.fin_correction_review_items WHERE collection_id = p_collection_id;
  IF NOT coalesce((p->>'evidence_received')::boolean,false) THEN RETURN f; END IF;
  amt := nullif(p->>'evidence_amount','')::numeric;
  ref := nullif(btrim(p->>'evidence_reference'),'');
  d := nullif(p->>'evidence_date','')::date;
  IF nullif(p->>'evidence_type','') IS NULL THEN f := f || 'Missing evidence type'; END IF;
  IF amt IS NULL THEN f := f || 'Missing evidence amount';
  ELSIF amt < i.collection_amount THEN f := f || 'Amount mismatch' || 'Partial amount';
  ELSIF amt > i.collection_amount THEN f := f || 'Amount mismatch' || 'Excess amount'; END IF;
  IF nullif(btrim(p->>'payer_identity'),'') IS NOT NULL AND i.tenant_name IS NOT NULL
     AND position(lower(split_part(btrim(i.tenant_name),' ',1)) in lower(p->>'payer_identity')) = 0 THEN
    f := f || 'Tenant/payer mismatch'; END IF;
  IF d IS NOT NULL AND abs(d - (i.collected_at AT TIME ZONE 'Africa/Kampala')::date) > 1 THEN f := f || 'Date mismatch'; END IF;
  IF ref IS NOT NULL AND EXISTS (SELECT 1 FROM public.fin_correction_review_items x WHERE x.collection_id <> p_collection_id
       AND lower(btrim(x.evidence_reference)) = lower(ref)
       AND coalesce(x.evidence_group_id,'') IS DISTINCT FROM coalesce(nullif(btrim(p->>'evidence_group_id'),''),'#none')) THEN
    f := f || 'Reused evidence reference'; END IF;
  IF nullif(btrim(p->>'evidence_group_id'),'') IS NOT NULL THEN
    f := f || 'Combined/shared payment';
    IF nullif(btrim(p->>'shared_receipt_explanation'),'') IS NULL THEN f := f || 'Shared receipt without explanation'; END IF;
  END IF;
  RETURN f;
END $$;

CREATE OR REPLACE FUNCTION public.cfo_correction_review_list(p_include_test boolean DEFAULT false)
RETURNS SETOF public.fin_correction_review_items LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY SELECT * FROM public.fin_correction_review_items WHERE (p_include_test OR NOT is_test)
    ORDER BY is_test DESC, priority_group, collected_at;
END $$;

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
  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (auth.uid(), 'evidence_review_saved', 'fin_correction_review_items', p_collection_id::text,
          jsonb_build_object('result', res, 'state', st, 'flags', fl, 'reason', 'Finance evidence review saved (review only, no financial correction)'));
  RETURN jsonb_build_object('item', to_jsonb(n), 'flags', fl);
END $$;

REVOKE ALL ON FUNCTION public.cfo_save_evidence_review(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_correction_review_list(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_correction_review_flags(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_save_evidence_review(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_correction_review_list(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fin_correction_review_flags(uuid, jsonb) TO authenticated;