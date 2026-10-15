ALTER TABLE public.staff_requisition_usage_reports
  ADD COLUMN IF NOT EXISTS approved_amount_snapshot numeric,
  ADD COLUMN IF NOT EXISTS receipt_total numeric CHECK (receipt_total IS NULL OR receipt_total >= 0),
  ADD COLUMN IF NOT EXISTS receipt_mismatch_explanation text,
  ADD COLUMN IF NOT EXISTS unspent_explanation text,
  ADD COLUMN IF NOT EXISTS overspend_explanation text,
  ADD COLUMN IF NOT EXISTS refund_status text CHECK (refund_status IS NULL OR refund_status IN ('made','pending','not_required')),
  ADD COLUMN IF NOT EXISTS refund_evidence_paths text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS refund_not_required_reason text,
  ADD COLUMN IF NOT EXISTS discrepancy_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discrepancy_reasons text[] NOT NULL DEFAULT '{}';

CREATE TABLE public.staff_requisition_usage_report_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES public.staff_requisition_usage_reports(id) ON DELETE RESTRICT,
  requisition_id uuid NOT NULL,
  reviewer_id uuid NOT NULL,
  verified_receipt_total numeric CHECK (verified_receipt_total IS NULL OR verified_receipt_total >= 0),
  decision text NOT NULL CHECK (decision IN ('verify_amount','accept_discrepancy','request_clarification','require_refund')),
  note text NOT NULL CHECK (char_length(btrim(note)) >= 10),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.staff_requisition_usage_report_reviews TO authenticated;
GRANT ALL ON public.staff_requisition_usage_report_reviews TO service_role;
ALTER TABLE public.staff_requisition_usage_report_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "requester or finance reads usage report reviews" ON public.staff_requisition_usage_report_reviews
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'super_admin')
    OR EXISTS (SELECT 1 FROM public.staff_requisition_usage_reports r WHERE r.id = report_id AND r.requester_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.usage_reviews_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Usage report reviews are append-only'; END $$;
CREATE TRIGGER trg_usage_reviews_append_only BEFORE UPDATE OR DELETE ON public.staff_requisition_usage_report_reviews
  FOR EACH ROW EXECUTE FUNCTION public.usage_reviews_append_only();

-- Shared rules; also used by the BEFORE INSERT trigger so a direct insert cannot skip them.
CREATE OR REPLACE FUNCTION public._usage_report_evaluate(p_approved numeric, p_used numeric, p_receipt numeric,
  p_mismatch text, p_unspent text, p_over text, p_refund text, p_refund_evidence int, p_refund_reason text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE reasons text[] := '{}'; problems text[] := '{}'; v_unspent numeric;
BEGIN
  IF p_receipt IS NULL THEN
    reasons := reasons || 'receipt_total_unverified';
    RETURN jsonb_build_object('flag', true, 'reasons', to_jsonb(reasons), 'problems', to_jsonb(problems));
  END IF;
  IF round(p_receipt) <> round(p_used) THEN
    reasons := reasons || 'receipt_vs_used_mismatch';
    IF coalesce(char_length(btrim(p_mismatch)),0) < 10 THEN problems := problems || 'Explain why the receipt total differs from the amount used (at least 10 characters).'; END IF;
  END IF;
  v_unspent := round(coalesce(p_approved,0)) - round(p_receipt);
  IF v_unspent > 0 THEN
    reasons := reasons || 'unspent_balance';
    IF coalesce(char_length(btrim(p_unspent)),0) < 10 THEN problems := problems || 'Explain the unspent balance (at least 10 characters).'; END IF;
    IF p_refund IS NULL THEN problems := problems || 'Choose the refund status for the unspent balance.';
    ELSIF p_refund = 'made' AND coalesce(p_refund_evidence,0) = 0 THEN problems := problems || 'Attach proof of the refund.';
    ELSIF p_refund = 'not_required' AND coalesce(char_length(btrim(p_refund_reason)),0) < 10 THEN problems := problems || 'Explain why no refund is required (at least 10 characters).';
    END IF;
  ELSIF v_unspent < 0 THEN
    reasons := reasons || 'overspend';
    IF coalesce(char_length(btrim(p_over)),0) < 10 THEN problems := problems || 'Explain the amount spent above the approved amount (at least 10 characters).'; END IF;
  END IF;
  RETURN jsonb_build_object('flag', cardinality(reasons) > 0, 'reasons', to_jsonb(reasons), 'problems', to_jsonb(problems));
END $$;

CREATE OR REPLACE FUNCTION public.usage_report_matching_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_eval jsonb;
BEGIN
  SELECT coalesce(approved_amount, amount) INTO NEW.approved_amount_snapshot FROM public.staff_requisitions WHERE id = NEW.requisition_id;
  v_eval := public._usage_report_evaluate(NEW.approved_amount_snapshot, NEW.amount_used, NEW.receipt_total,
    NEW.receipt_mismatch_explanation, NEW.unspent_explanation, NEW.overspend_explanation, NEW.refund_status,
    cardinality(NEW.refund_evidence_paths), NEW.refund_not_required_reason);
  -- Older clients send no receipt total: allowed, but flagged for manual verification.
  IF NEW.receipt_total IS NOT NULL AND jsonb_array_length(v_eval->'problems') > 0 THEN
    RAISE EXCEPTION '%', v_eval->'problems'->>0 USING ERRCODE = '22023';
  END IF;
  NEW.discrepancy_flag := (v_eval->>'flag')::boolean;
  NEW.discrepancy_reasons := ARRAY(SELECT jsonb_array_elements_text(v_eval->'reasons'));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_usage_report_matching_guard BEFORE INSERT ON public.staff_requisition_usage_reports
  FOR EACH ROW EXECUTE FUNCTION public.usage_report_matching_guard();

-- Amounts/explanations are frozen once submitted; only review fields may change.
CREATE OR REPLACE FUNCTION public.usage_report_freeze_amounts() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (NEW.amount_used, NEW.receipt_total, NEW.approved_amount_snapshot, NEW.receipt_mismatch_explanation, NEW.unspent_explanation,
      NEW.overspend_explanation, NEW.refund_status, NEW.refund_evidence_paths, NEW.refund_not_required_reason, NEW.attachment_paths, NEW.discrepancy_flag)
     IS DISTINCT FROM
     (OLD.amount_used, OLD.receipt_total, OLD.approved_amount_snapshot, OLD.receipt_mismatch_explanation, OLD.unspent_explanation,
      OLD.overspend_explanation, OLD.refund_status, OLD.refund_evidence_paths, OLD.refund_not_required_reason, OLD.attachment_paths, OLD.discrepancy_flag) THEN
    RAISE EXCEPTION 'Submitted usage report amounts cannot be changed; record a reviewer verification instead';
  END IF;
  IF NEW.review_status = 'accepted' AND OLD.review_status <> 'accepted' AND NEW.discrepancy_flag
     AND NOT EXISTS (SELECT 1 FROM public.staff_requisition_usage_report_reviews v WHERE v.report_id = NEW.id AND v.decision = 'accept_discrepancy') THEN
    RAISE EXCEPTION 'This report has flagged amount differences. Record a review decision (Accept discrepancy) before accepting.' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_usage_report_freeze_amounts BEFORE UPDATE ON public.staff_requisition_usage_reports
  FOR EACH ROW EXECUTE FUNCTION public.usage_report_freeze_amounts();

CREATE OR REPLACE FUNCTION public.submit_requisition_usage_report(
  p_requisition_id uuid, p_amount_used numeric, p_receipt_total numeric, p_summary text, p_attachment_paths text[],
  p_mismatch_explanation text DEFAULT NULL, p_unspent_explanation text DEFAULT NULL, p_overspend_explanation text DEFAULT NULL,
  p_refund_status text DEFAULT NULL, p_refund_evidence_paths text[] DEFAULT '{}', p_refund_not_required_reason text DEFAULT NULL,
  p_places_visited text DEFAULT NULL, p_activities text DEFAULT NULL, p_results text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req record; v_id uuid; v_flag boolean; v_reasons text[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  SELECT id, requester_id, stage, coalesce(approved_amount, amount) appr INTO v_req FROM public.staff_requisitions WHERE id = p_requisition_id FOR UPDATE;
  IF NOT FOUND OR v_req.requester_id <> v_uid THEN RAISE EXCEPTION 'Only the requester can submit this report' USING ERRCODE = '42501'; END IF;
  IF v_req.stage <> 'approved' THEN RAISE EXCEPTION 'This requisition is not awaiting an accountability report' USING ERRCODE = '22023'; END IF;
  IF p_receipt_total IS NULL THEN RAISE EXCEPTION 'Enter the total shown on your receipts' USING ERRCODE = '22023'; END IF;
  IF coalesce(cardinality(p_attachment_paths),0) = 0 THEN RAISE EXCEPTION 'Attach at least one receipt' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.staff_requisition_usage_reports (requisition_id, requester_id, amount_used, receipt_total, summary, attachment_paths,
    receipt_mismatch_explanation, unspent_explanation, overspend_explanation, refund_status, refund_evidence_paths, refund_not_required_reason,
    places_visited, activities_carried_out, results_achieved)
  VALUES (p_requisition_id, v_uid, p_amount_used, p_receipt_total, btrim(p_summary), p_attachment_paths,
    nullif(btrim(p_mismatch_explanation),''), nullif(btrim(p_unspent_explanation),''), nullif(btrim(p_overspend_explanation),''),
    p_refund_status, coalesce(p_refund_evidence_paths,'{}'), nullif(btrim(p_refund_not_required_reason),''),
    p_places_visited, p_activities, p_results)
  RETURNING id, discrepancy_flag, discrepancy_reasons INTO v_id, v_flag, v_reasons;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'requisition_usage_report_submitted', 'staff_requisition_usage_reports', v_id::text,
    'Accountability report submitted with amount matching',
    jsonb_build_object('requisition_id', p_requisition_id, 'approved', v_req.appr, 'amount_used', p_amount_used,
      'receipt_total', p_receipt_total, 'discrepancy_flag', v_flag, 'reasons', v_reasons, 'refund_status', p_refund_status,
      'receipts', p_attachment_paths, 'refund_evidence', p_refund_evidence_paths,
      'mismatch_explanation', p_mismatch_explanation, 'unspent_explanation', p_unspent_explanation,
      'overspend_explanation', p_overspend_explanation, 'refund_not_required_reason', p_refund_not_required_reason));
  RETURN jsonb_build_object('report_id', v_id, 'discrepancy_flag', v_flag, 'reasons', to_jsonb(v_reasons));
END $$;
REVOKE ALL ON FUNCTION public.submit_requisition_usage_report(uuid,numeric,numeric,text,text[],text,text,text,text,text[],text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_requisition_usage_report(uuid,numeric,numeric,text,text[],text,text,text,text,text[],text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_requisition_usage_report(p_report_id uuid, p_decision text, p_note text, p_verified_receipt_total numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_rep record; v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'super_admin')) THEN
    RAISE EXCEPTION 'Only the CFO can review accountability amounts' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('verify_amount','accept_discrepancy','request_clarification','require_refund') THEN
    RAISE EXCEPTION 'Unknown review decision' USING ERRCODE = '22023'; END IF;
  IF p_note IS NULL OR char_length(btrim(p_note)) < 10 THEN RAISE EXCEPTION 'Add a review note of at least 10 characters' USING ERRCODE = '22023'; END IF;
  IF p_decision = 'verify_amount' AND p_verified_receipt_total IS NULL THEN RAISE EXCEPTION 'Enter the verified receipt total' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_rep FROM public.staff_requisition_usage_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report not found' USING ERRCODE = '22023'; END IF;
  IF v_rep.requester_id = v_uid THEN RAISE EXCEPTION 'You cannot review your own report' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.staff_requisition_usage_report_reviews (report_id, requisition_id, reviewer_id, verified_receipt_total, decision, note)
  VALUES (p_report_id, v_rep.requisition_id, v_uid, p_verified_receipt_total, p_decision, btrim(p_note)) RETURNING id INTO v_id;
  IF p_decision IN ('request_clarification','require_refund') THEN
    UPDATE public.staff_requisition_usage_reports SET review_status = 'clarification_requested', reviewed_by = v_uid, reviewed_at = now(), review_note = btrim(p_note) WHERE id = p_report_id;
  END IF;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'requisition_usage_report_reviewed', 'staff_requisition_usage_reports', p_report_id::text, btrim(p_note),
    jsonb_build_object('review_id', v_id, 'decision', p_decision, 'verified_receipt_total', p_verified_receipt_total,
      'receipt_total', v_rep.receipt_total, 'amount_used', v_rep.amount_used, 'approved', v_rep.approved_amount_snapshot));
  RETURN jsonb_build_object('review_id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.review_requisition_usage_report(uuid,text,text,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_requisition_usage_report(uuid,text,text,numeric) TO authenticated;