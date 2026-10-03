CREATE TABLE public.fin_s14_batch_cases (
  batch_no int NOT NULL,
  collection_id uuid NOT NULL REFERENCES public.fin_s14_cases(collection_id),
  position int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_no, collection_id)
);
INSERT INTO public.fin_s14_batch_cases (batch_no, collection_id, position)
SELECT 1, c.collection_id, row_number() OVER (ORDER BY r.collected_at, c.collection_id)
FROM public.fin_s14_cases c JOIN public.fin_collection_reconciliation_s11 r USING (collection_id)
WHERE c.case_type = 'duplicate'
ORDER BY r.collected_at, c.collection_id LIMIT 20;
GRANT SELECT ON public.fin_s14_batch_cases TO authenticated;
GRANT ALL ON public.fin_s14_batch_cases TO service_role;
ALTER TABLE public.fin_s14_batch_cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO approvers read S14 batches" ON public.fin_s14_batch_cases FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));
CREATE TRIGGER trg_fin_s14_batch_append_only BEFORE UPDATE OR DELETE ON public.fin_s14_batch_cases FOR EACH ROW EXECUTE FUNCTION public.fin_s14_append_only();

CREATE OR REPLACE FUNCTION public.fin_s14_require_batch() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $f$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fin_s14_batch_cases WHERE collection_id = NEW.collection_id) THEN
    RAISE EXCEPTION 'This case is not in an open Stage 14 batch — evidence and decisions are only accepted for batch cases';
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER trg_fin_s14_evidence_batch BEFORE INSERT ON public.fin_s14_evidence FOR EACH ROW EXECUTE FUNCTION public.fin_s14_require_batch();
CREATE TRIGGER trg_fin_s14_audit_batch BEFORE INSERT ON public.fin_s14_audit FOR EACH ROW EXECUTE FUNCTION public.fin_s14_require_batch();

CREATE OR REPLACE FUNCTION public.cfo_s14_batch(p_batch int)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  PERFORM public.fin_s14_assert_controls();
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('collection_id', collection_id, 'position', position) ORDER BY position)
    FROM public.fin_s14_batch_cases WHERE batch_no = p_batch), '[]'::jsonb);
END $f$;
REVOKE ALL ON FUNCTION public.cfo_s14_batch(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_s14_batch(int) TO authenticated;