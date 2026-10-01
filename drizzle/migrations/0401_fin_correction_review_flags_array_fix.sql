CREATE OR REPLACE FUNCTION public.fin_correction_review_flags(p_collection_id uuid, p jsonb)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.fin_correction_review_items; f text[] := '{}'; amt numeric; ref text; d date;
BEGIN
  SELECT * INTO i FROM public.fin_correction_review_items WHERE collection_id = p_collection_id;
  IF NOT coalesce((p->>'evidence_received')::boolean,false) THEN RETURN f; END IF;
  amt := nullif(p->>'evidence_amount','')::numeric;
  ref := nullif(btrim(p->>'evidence_reference'),'');
  d := nullif(p->>'evidence_date','')::date;
  IF nullif(p->>'evidence_type','') IS NULL THEN f := f || ARRAY['Missing evidence type']; END IF;
  IF amt IS NULL THEN f := f || ARRAY['Missing evidence amount'];
  ELSIF amt < i.collection_amount THEN f := f || ARRAY['Amount mismatch','Partial amount'];
  ELSIF amt > i.collection_amount THEN f := f || ARRAY['Amount mismatch','Excess amount']; END IF;
  IF nullif(btrim(p->>'payer_identity'),'') IS NOT NULL AND i.tenant_name IS NOT NULL
     AND position(lower(split_part(btrim(i.tenant_name),' ',1)) in lower(p->>'payer_identity')) = 0 THEN
    f := f || ARRAY['Tenant/payer mismatch']; END IF;
  IF d IS NOT NULL AND abs(d - (i.collected_at AT TIME ZONE 'Africa/Kampala')::date) > 1 THEN f := f || ARRAY['Date mismatch']; END IF;
  IF ref IS NOT NULL AND EXISTS (SELECT 1 FROM public.fin_correction_review_items x WHERE x.collection_id <> p_collection_id
       AND lower(btrim(x.evidence_reference)) = lower(ref)
       AND coalesce(x.evidence_group_id,'') IS DISTINCT FROM coalesce(nullif(btrim(p->>'evidence_group_id'),''),'#none')) THEN
    f := f || ARRAY['Reused evidence reference']; END IF;
  IF nullif(btrim(p->>'evidence_group_id'),'') IS NOT NULL THEN
    f := f || ARRAY['Combined/shared payment'];
    IF nullif(btrim(p->>'shared_receipt_explanation'),'') IS NULL THEN f := f || ARRAY['Shared receipt without explanation']; END IF;
  END IF;
  RETURN f;
END $$;