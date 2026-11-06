-- Rollback of 20261104170000_merchandise_stock_recognise_on_issue: restores _merch_post_stock_recognition,
-- cfo_post_merchandise_stock_recognition, _merch_stock_on_handover and trg_merch_stock_issue_event to the Phase 3
-- definitions (20261104150000, verbatim) and drops _merch_stock_on_issue and _merch_order_marked_issued.
-- STAY (append-only / evidence): the 7 recognition groups (merch_stock_recog:%) and any later ones, the queue rows, and the
-- widened evidence_kind check (rows recorded as order_issued stay valid). To reverse an amount, post a reversing entry.
SET lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public._merch_post_stock_recognition(p_review uuid, p_evidence_kind text, p_evidence text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; s record; v jsonb; v_amt numeric; v_key text; v_group uuid; v_desc text; v_entries jsonb;
  p_counterpart constant text := 'revenue'; p_note text;
BEGIN
  IF p_evidence_kind IS NULL OR p_evidence_kind NOT IN ('handover_record', 'cfo_verified_document') THEN
    RAISE EXCEPTION 'delivery evidence kind must be handover_record or cfo_verified_document';
  END IF;
  SELECT * INTO r FROM public.merchandise_stock_recognitions WHERE id = p_review FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock recognition % not found', p_review; END IF;
  IF r.status <> 'pending' THEN
    RETURN jsonb_build_object('id', r.id, 'status', r.status, 'ledger_group_id', r.ledger_group_id, 'already', true);
  END IF;
  SELECT * INTO s FROM public.merchandise_sales WHERE id = r.sale_id;
  IF p_evidence_kind = 'handover_record' AND (s.handed_over_at IS NULL OR s.handed_over_by IS NULL) THEN
    RAISE EXCEPTION 'no handover record on order %: recognise only on verified delivery evidence', r.sale_id;
  END IF;
  IF p_evidence_kind = 'cfo_verified_document' AND length(btrim(COALESCE(p_evidence, ''))) < 20 THEN
    RAISE EXCEPTION 'name the delivery document verified (at least 20 characters)';
  END IF;
  p_note := p_evidence_kind || ': ' || COALESCE(btrim(p_evidence), '');
  -- recomputed now: what was paid or recognised since it was queued is taken into account; an order that is no longer
  -- issued (rejected / cancelled / failed / deleted) recognises nothing (the derecognition controls cover what is left)
  v := public._merch_stock_receivable_due(r.sale_id);
  v_amt := CASE WHEN s.id IS NULL OR s.order_status NOT IN ('issued', 'completed', 'approved') THEN 0
                ELSE COALESCE((v->>'due')::numeric, 0) END;
  v_key := 'merch_stock_recog:' || r.id::text;
  IF v_amt > 0 THEN
    v_desc := 'Company stock issued on credit: ' || COALESCE(r.item_name, 'merchandise') || ' - receivable ' || r.account
              || ' / sales revenue (R1)'
              || ' - ' || COALESCE(p_note, '');
      v_entries := jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_amt,
          'category', CASE r.account WHEN 'A13' THEN 'bike_recovery_repayment' ELSE 'smartphone_advance_receivable' END,
          'source_table', 'merchandise_sales', 'source_id', r.sale_id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_amt, 'category', 'merchandise_revenue',
          'source_table', 'merchandise_sales', 'source_id', r.sale_id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc));
    v_group := public.create_ledger_transaction(entries => v_entries, idempotency_key => v_key);
  END IF;
  UPDATE public.merchandise_stock_recognitions
  SET status = CASE WHEN v_group IS NULL THEN 'no_action' ELSE 'posted' END,
      counterpart = CASE WHEN v_group IS NULL THEN NULL ELSE p_counterpart END,
      amount = v_amt, amount_paid = COALESCE((v->>'amount_paid')::numeric, amount_paid),
      ledger_group_id = v_group, idempotency_key = CASE WHEN v_group IS NULL THEN NULL ELSE v_key END,
      evidence_kind = p_evidence_kind, delivery_evidence = btrim(p_evidence),
      decided_by = p_actor, decided_at = now(), decision_note = p_note, updated_at = now()
  WHERE id = r.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (p_actor, 'merchandise_stock_recognised', 'merchandise_stock_recognitions', r.id::text, p_note,
          jsonb_build_object('sale_id', r.sale_id, 'counterpart', p_counterpart, 'amount', v_amt, 'ledger_group_id', v_group,
                             'idempotency_key', v_key, 'due', v));
  RETURN jsonb_build_object('id', r.id, 'status', CASE WHEN v_group IS NULL THEN 'no_action' ELSE 'posted' END,
    'ledger_group_id', v_group, 'amount', v_amt, 'counterpart', p_counterpart);
END $function$;

CREATE OR REPLACE FUNCTION public.cfo_post_merchandise_stock_recognition(p_review_id uuid, p_delivery_evidence text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_sale uuid; v_handed boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'cfo'::app_role) OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Only the CFO can recognise a company-stock receivable';
  END IF;
  SELECT r.sale_id, (s.handed_over_at IS NOT NULL AND s.handed_over_by IS NOT NULL) INTO v_sale, v_handed
  FROM public.merchandise_stock_recognitions r LEFT JOIN public.merchandise_sales s ON s.id = r.sale_id WHERE r.id = p_review_id;
  IF v_sale IS NULL THEN RAISE EXCEPTION 'stock recognition % not found', p_review_id; END IF;
  -- sales revenue only (CFO decision 2026-11-04), and only on verified delivery evidence
  IF v_handed THEN
    RETURN public._merch_post_stock_recognition(p_review_id, 'handover_record', COALESCE(NULLIF(btrim(p_delivery_evidence), ''), 'handover record'), auth.uid());
  END IF;
  IF length(btrim(COALESCE(p_delivery_evidence, ''))) < 20 THEN
    RAISE EXCEPTION 'No handover record: name the delivery document you verified (at least 20 characters), or leave the item in the queue';
  END IF;
  RETURN public._merch_post_stock_recognition(p_review_id, 'cfo_verified_document', btrim(p_delivery_evidence), auth.uid());
END $function$;

CREATE OR REPLACE FUNCTION public._merch_stock_on_handover(p_sale uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- A confirmed handover is the delivery evidence: queue the order if it is not queued yet, and recognise the receivable
-- and the revenue once, in the handover's own transaction, when the CFO's standing choice is 'revenue'.
DECLARE s record; v_id uuid; v_auto text;
BEGIN
  SELECT * INTO s FROM public.merchandise_sales WHERE id = p_sale;
  IF NOT FOUND OR s.handed_over_at IS NULL OR s.handed_over_by IS NULL THEN RETURN; END IF;
  IF s.cfo_disbursed_at IS NOT NULL OR s.disbursement_group_id IS NOT NULL OR s.customer_id IS NULL THEN RETURN; END IF;
  PERFORM public._merch_stock_queue(p_sale, 'issue');
  SELECT id INTO v_id FROM public.merchandise_stock_recognitions WHERE sale_id = p_sale AND status = 'pending';
  SELECT stock_issue_counterpart INTO v_auto FROM public.merchandise_accounting_controls WHERE id;
  IF v_id IS NOT NULL AND v_auto = 'revenue' THEN
    PERFORM public._merch_post_stock_recognition(v_id, 'handover_record',
      COALESCE(NULLIF(btrim(s.handover_note), ''), 'handover confirmed ' || to_char(s.handed_over_at, 'YYYY-MM-DD')), s.handed_over_by);
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_merch_stock_issue_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.cfo_disbursed_at IS NOT NULL OR NEW.disbursement_group_id IS NOT NULL OR NEW.customer_id IS NULL THEN RETURN NULL; END IF;
  IF (NEW.order_status IN ('issued', 'completed') OR (NEW.order_status = 'approved' AND NEW.issued_channel = 'agent_ops'))
     AND NOT (TG_OP = 'UPDATE' AND (OLD.order_status IN ('issued', 'completed')
                                    OR (OLD.order_status = 'approved' AND OLD.issued_channel = 'agent_ops'))) THEN
    PERFORM public._merch_stock_queue(NEW.id, 'issue');
  END IF;
  IF NEW.handed_over_at IS NOT NULL AND NEW.handed_over_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.handed_over_at IS NULL OR OLD.handed_over_by IS NULL) THEN
    PERFORM public._merch_stock_on_handover(NEW.id);
  END IF;
  RETURN NULL;
END $function$;

DROP FUNCTION public._merch_stock_on_issue(uuid);
DROP FUNCTION public._merch_order_marked_issued(text, text);
REVOKE ALL ON FUNCTION public._merch_post_stock_recognition(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_stock_on_handover(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_merch_stock_issue_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cfo_post_merchandise_stock_recognition(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_post_merchandise_stock_recognition(uuid, text) TO authenticated;
COMMENT ON COLUMN public.merchandise_accounting_controls.stock_issue_counterpart IS
  'CFO decision 2026-11-04: ''revenue''. Company stock issued on credit is queued in merchandise_stock_recognitions; '
  'the receivable and the revenue (DR A12/A13 / CR R1 merchandise_revenue) are recognised automatically only when the '
  'handover is confirmed (handed_over_at and handed_over_by). NULL: every item waits for the CFO.';
