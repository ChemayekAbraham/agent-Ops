CREATE OR REPLACE FUNCTION public.cfo_s13_correction_review()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE r jsonb; v_dec int;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  PERFORM public.fin_s12_assert_controls();
  SELECT count(*) INTO v_dec FROM public.fin_collection_evidence_s12_audit;
  SELECT jsonb_build_object(
    'controls', jsonb_build_object(
      'stage11_count', (SELECT count(*) FROM public.fin_collection_reconciliation_s11),
      'stage11_amount', (SELECT coalesce(sum(amount),0) FROM public.fin_collection_reconciliation_s11),
      'decisions', v_dec,
      'financial_writes_this_txn', public.fin_s12_txn_financial_writes()),
    'candidates', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'collection_id', s.collection_id, 'collected_at', s.collected_at, 'tenant_name', s.tenant_name, 'rent_plan_id', s.rent_plan_id,
        'amount', s.amount, 'stage11', s.reconciliation_result, 'stage12', e.evidence_status, 'evidence_reference', e.evidence_reference,
        'valid_original_id', e.valid_original_id, 'confirmed_agent_id', e.confirmed_agent_id) ORDER BY s.collected_at)
      FROM public.fin_collection_reconciliation_s11 s JOIN public.fin_collection_evidence_s12 e USING (collection_id)
      WHERE e.evidence_status IN ('Confirmed Duplicate','Confirmed Agent Mismatch')), '[]'::jsonb),
    'groups', coalesce((SELECT jsonb_agg(jsonb_build_object('stage11', g.res, 'stage12', g.st, 'count', g.n, 'amount', g.a) ORDER BY g.res, g.st)
      FROM (SELECT s.reconciliation_result res, e.evidence_status st, count(*) n, sum(s.amount) a
            FROM public.fin_collection_reconciliation_s11 s JOIN public.fin_collection_evidence_s12 e USING (collection_id)
            WHERE e.evidence_status NOT IN ('Confirmed Duplicate','Confirmed Agent Mismatch') GROUP BY 1,2) g), '[]'::jsonb)
  ) INTO r;
  RETURN r;
END $f$;
REVOKE ALL ON FUNCTION public.cfo_s13_correction_review() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_s13_correction_review() TO authenticated;