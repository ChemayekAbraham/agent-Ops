-- 2026-11-04: company stock - the receivable is recognised when the order is marked issued (CFO policy 2026-11-04:
-- "once merchandise is marked as issued, it automatically qualifies for recognition in receivables. No separate proof of
-- receipt, signed delivery note or handover confirmation is required."). Replaces the Phase 3 rule (20261104150000) that
-- recognised only on a handover record or a CFO-verified delivery document. Production apply needs explicit CFO approval.
-- Apply AFTER 20261104150000 (the preflight refuses otherwise). Independent of 20261104160000 (3b).
-- ACCOUNTING ONLY: no wallet leg, payment, refund, order / plan status, amount or eligibility change.
--   1. "Marked as issued" = order_status 'issued' or 'completed', or an Agent Ops issue (agent_ops_issue_agent_product:
--      inserted 'approved' with issued_channel 'agent_ops') - the same issue events Phase 3 already queues.
--   2. On that event the order is queued and recognised in the same transaction: DR A12 / A13 (the receivable still to
--      recognise, _merch_stock_receivable_due, unchanged) / CR R1 merchandise_revenue (sales revenue, CFO decision
--      2026-11-04). evidence_kind 'order_issued'. Once per order (one queue row per order; key merch_stock_recog:<row>).
--      merchandise_accounting_controls.stock_issue_counterpart stays the switch: NULL = every item waits for the CFO.
--   3. cfo_post_merchandise_stock_recognition: an issued order is recognised with no document; an order not (yet) marked
--      issued is refused (it is recognised automatically when it is); a rejected / cancelled / deleted order closes as
--      no action. A handover is no longer required (it still sets the order issued, which recognises it).
--   4. One-off: the 7 company-stock items queued by Phase 3 (all marked issued 24-25 Sep, 1,015,000) are recognised now:
--      7 groups DR A12 / CR R1 merchandise_revenue. Amounts recomputed at apply time and pinned by the preflight.
--   Unchanged: payout orders (bike, smartphone, out-sourced) open their receivable at payout; cancellations after
--   recognition go to the derecognition queue (20261104100000); collection eligibility (merchandise_plan_recovery_eligible)
--   is not changed - it decides when money is taken, not what is recognised.
-- Rollback: supabase/rollbacks/20261104170000_merchandise_stock_recognise_on_issue.rollback.sql (functions; posted entries and rows stay).
-- Tests: src/test/merchandiseStockOnIssue.test.ts. Dry run: supabase/tests/merchandise_stock_on_issue_dryrun.sql.
-- TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';

DO $pre$
DECLARE v_n int; v_amt numeric; v_bad int;
BEGIN
  IF to_regprocedure('public._merch_order_marked_issued(text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'stock on issue: already applied';
  END IF;
  -- Phase 3 is in place, with the definitions this migration replaces
  IF to_regclass('public.merchandise_stock_recognitions') IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_post_stock_recognition(uuid, text, text, uuid)'))
       IS DISTINCT FROM '02ef461b3be40455767aedf0582c9351'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_post_merchandise_stock_recognition(uuid, text)'))
       IS DISTINCT FROM 'bd7bb30d5d5278a08c75c6633fdce853'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_stock_on_handover(uuid)'))
       IS DISTINCT FROM 'eb39ed08009547bc584c086c92bf2091'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.trg_merch_stock_issue_event()'))
       IS DISTINCT FROM '6cc969e183f4d4733ba7e51c28eb3308'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_stock_queue(uuid, text)'))
       IS DISTINCT FROM '89553dbcc1749ad9ade915c8bd4ad19a'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_stock_receivable_due(uuid)'))
       IS DISTINCT FROM '207408ebee59bc98fd0b0b37e2983857' THEN
    RAISE EXCEPTION 'stock on issue: apply 20261104150000 first (or its stock functions have changed since)';
  END IF;
  -- evidence: the 7 items Phase 3 queued are still pending, still issued, nothing recognised for them, due as queued
  SELECT count(*), COALESCE(sum(r.amount), 0),
         count(*) FILTER (WHERE s.id IS NULL OR s.order_status <> 'issued' OR s.cfo_disbursed_at IS NOT NULL
                            OR s.disbursement_group_id IS NOT NULL
                            OR (public._merch_stock_receivable_due(r.sale_id)->>'due')::numeric <> r.amount
                            OR EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = 'merch_stock_recog:' || r.id::text))
    INTO v_n, v_amt, v_bad
  FROM public.merchandise_stock_recognitions r LEFT JOIN public.merchandise_sales s ON s.id = r.sale_id
  WHERE r.status = 'pending';
  IF v_n <> 7 OR v_amt <> 1015000 OR v_bad <> 0
     OR EXISTS (SELECT 1 FROM public.merchandise_stock_recognitions WHERE status <> 'pending' OR origin <> 'historical_20261104') THEN
    RAISE EXCEPTION 'stock on issue: queue moved since 2026-11-04 (% pending, %, % changed) - re-run the dry run', v_n, v_amt, v_bad;
  END IF;
  -- no other issued company-stock order carries a receivable that was never recognised
  IF EXISTS (SELECT 1 FROM public.merchandise_sales s
             WHERE s.order_status IN ('issued', 'completed') AND s.cfo_disbursed_at IS NULL AND s.disbursement_group_id IS NULL
               AND s.customer_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.merchandise_stock_recognitions r WHERE r.sale_id = s.id)
               AND COALESCE((public._merch_stock_receivable_due(s.id)->>'due')::numeric, 0) > 0) THEN
    RAISE EXCEPTION 'stock on issue: an issued order outside the queue has an unrecognised receivable - re-run the dry run';
  END IF;
  IF (SELECT stock_issue_counterpart FROM public.merchandise_accounting_controls WHERE id) IS DISTINCT FROM 'revenue' THEN
    RAISE EXCEPTION 'stock on issue: merchandise_accounting_controls.stock_issue_counterpart is not ''revenue''';
  END IF;
END $pre$;

-- ---------------------------------------------------------------- 1. the policy
ALTER TABLE public.merchandise_stock_recognitions DROP CONSTRAINT merchandise_stock_recognitions_evidence_kind_check;
ALTER TABLE public.merchandise_stock_recognitions ADD CONSTRAINT merchandise_stock_recognitions_evidence_kind_check
  CHECK (evidence_kind IN ('order_issued', 'handover_record', 'cfo_verified_document'));
COMMENT ON COLUMN public.merchandise_stock_recognitions.evidence_kind IS
  'order_issued: recognised because the order was marked issued (CFO policy 2026-11-04: no separate proof of receipt, '
  'delivery note or handover needed). handover_record / cfo_verified_document: the Phase 3 rule (none were posted under it).';
COMMENT ON TABLE public.merchandise_stock_recognitions IS
  'Company stock issued to an agent on credit: the receivable and sales revenue, recognised when the order is marked issued '
  '(CFO policy 2026-11-04). One row per order. Written only by the merchandise controls (20261104150000, 20261104170000).';
COMMENT ON COLUMN public.merchandise_accounting_controls.stock_issue_counterpart IS
  'CFO decision 2026-11-04: ''revenue''. Company stock issued on credit is recognised (DR A12/A13 / CR R1 merchandise_revenue) '
  'automatically when the order is marked issued (CFO policy 2026-11-04). NULL: every item waits in merchandise_stock_recognitions for the CFO.';

CREATE OR REPLACE FUNCTION public._merch_order_marked_issued(p_status text, p_channel text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  -- CFO policy 2026-11-04: an order marked issued qualifies for recognition. 'completed' follows 'issued'; an Agent Ops
  -- issue (agent_ops_issue_agent_product) records the item as issued with status 'approved' and channel 'agent_ops'.
  SELECT COALESCE(p_status IN ('issued', 'completed') OR (p_status = 'approved' AND p_channel = 'agent_ops'), false)
$function$;

-- ---------------------------------------------------------------- 2. posting (one row per order, once)
CREATE OR REPLACE FUNCTION public._merch_post_stock_recognition(p_review uuid, p_evidence_kind text, p_evidence text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; s record; v jsonb; v_amt numeric; v_key text; v_group uuid; v_desc text; v_entries jsonb;
  p_counterpart constant text := 'revenue'; p_note text;
BEGIN
  IF p_evidence_kind IS NULL OR p_evidence_kind NOT IN ('order_issued', 'handover_record', 'cfo_verified_document') THEN
    RAISE EXCEPTION 'recognition basis must be order_issued, handover_record or cfo_verified_document';
  END IF;
  SELECT * INTO r FROM public.merchandise_stock_recognitions WHERE id = p_review FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock recognition % not found', p_review; END IF;
  IF r.status <> 'pending' THEN
    RETURN jsonb_build_object('id', r.id, 'status', r.status, 'ledger_group_id', r.ledger_group_id, 'already', true);
  END IF;
  SELECT * INTO s FROM public.merchandise_sales WHERE id = r.sale_id;
  IF p_evidence_kind = 'handover_record' AND (s.handed_over_at IS NULL OR s.handed_over_by IS NULL) THEN
    RAISE EXCEPTION 'no handover record on order %', r.sale_id;
  END IF;
  IF p_evidence_kind = 'cfo_verified_document' AND length(btrim(COALESCE(p_evidence, ''))) < 20 THEN
    RAISE EXCEPTION 'name the delivery document verified (at least 20 characters)';
  END IF;
  p_note := p_evidence_kind || ': ' || COALESCE(btrim(p_evidence), '');
  -- recomputed now: what was paid or recognised since it was queued is taken into account; an order that is no longer
  -- marked issued (rejected / cancelled / failed / deleted) recognises nothing (the derecognition controls cover the rest)
  v := public._merch_stock_receivable_due(r.sale_id);
  v_amt := CASE WHEN s.id IS NULL OR NOT public._merch_order_marked_issued(s.order_status, s.issued_channel) THEN 0
                ELSE COALESCE((v->>'due')::numeric, 0) END;
  v_key := 'merch_stock_recog:' || r.id::text;
  IF v_amt > 0 THEN
    v_desc := 'Company stock issued on credit: ' || COALESCE(r.item_name, 'merchandise') || ' - receivable ' || r.account
              || ' / sales revenue (R1) - ' || COALESCE(p_note, '');
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

-- Queue (if not yet) and recognise an order that is marked issued, once, in the caller's transaction.
CREATE OR REPLACE FUNCTION public._merch_stock_on_issue(p_sale uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE s record; v_id uuid; v_auto text;
BEGIN
  SELECT * INTO s FROM public.merchandise_sales WHERE id = p_sale;
  IF NOT FOUND OR NOT public._merch_order_marked_issued(s.order_status, s.issued_channel) THEN RETURN; END IF;
  IF s.cfo_disbursed_at IS NOT NULL OR s.disbursement_group_id IS NOT NULL OR s.customer_id IS NULL THEN RETURN; END IF;
  PERFORM public._merch_stock_queue(p_sale, 'issue');
  SELECT id INTO v_id FROM public.merchandise_stock_recognitions WHERE sale_id = p_sale AND status = 'pending';
  SELECT stock_issue_counterpart INTO v_auto FROM public.merchandise_accounting_controls WHERE id;
  IF v_id IS NOT NULL AND v_auto = 'revenue' THEN
    PERFORM public._merch_post_stock_recognition(v_id, 'order_issued',
      'order marked ' || s.order_status || COALESCE(' (' || s.issued_channel || ')', '') || ' on '
        || to_char(now() AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD'),
      COALESCE(auth.uid(), s.handed_over_by));
  END IF;
END $function$;

-- Kept for anything that still calls it: a handover sets the order issued, and issued is what recognises it.
CREATE OR REPLACE FUNCTION public._merch_stock_on_handover(p_sale uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._merch_stock_on_issue(p_sale);
END $function$;

-- Every path that marks company stock issued on credit with no payout behind it (handover -> issued, Agent Ops approval
-- of a non-boutique order -> issued, an Agent Ops issue, completion, a direct status edit) recognises it in the same
-- transaction. Orders with a CFO payout (bike, smartphone, out-sourced) open their receivable at payout and are excluded.
CREATE OR REPLACE FUNCTION public.trg_merch_stock_issue_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.cfo_disbursed_at IS NOT NULL OR NEW.disbursement_group_id IS NOT NULL OR NEW.customer_id IS NULL THEN RETURN NULL; END IF;
  IF public._merch_order_marked_issued(NEW.order_status, NEW.issued_channel)
     AND NOT (TG_OP = 'UPDATE' AND public._merch_order_marked_issued(OLD.order_status, OLD.issued_channel)) THEN
    PERFORM public._merch_stock_on_issue(NEW.id);
  END IF;
  RETURN NULL;
END $function$;

-- ---------------------------------------------------------------- 3. the CFO action
CREATE OR REPLACE FUNCTION public.cfo_post_merchandise_stock_recognition(p_review_id uuid, p_delivery_evidence text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_sale uuid; s record;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'cfo'::app_role) OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Only the CFO can recognise a company-stock receivable';
  END IF;
  SELECT r.sale_id INTO v_sale FROM public.merchandise_stock_recognitions r WHERE r.id = p_review_id;
  IF v_sale IS NULL THEN RAISE EXCEPTION 'stock recognition % not found', p_review_id; END IF;
  SELECT * INTO s FROM public.merchandise_sales WHERE id = v_sale;
  -- CFO policy 2026-11-04: marked issued is enough; no document or handover is needed
  IF FOUND AND NOT public._merch_order_marked_issued(s.order_status, s.issued_channel)
     AND s.order_status NOT IN ('rejected', 'cancelled', 'failed', 'deleted') THEN
    RAISE EXCEPTION 'Order is not marked issued (status %): it is recognised automatically when it is', s.order_status;
  END IF;
  RETURN public._merch_post_stock_recognition(p_review_id, 'order_issued',
    COALESCE(NULLIF(btrim(p_delivery_evidence), ''), 'order marked ' || COALESCE(s.order_status, 'deleted')), auth.uid());
END $function$;

REVOKE ALL ON FUNCTION public._merch_order_marked_issued(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_stock_on_issue(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_stock_on_handover(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_post_stock_recognition(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_merch_stock_issue_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cfo_post_merchandise_stock_recognition(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_post_merchandise_stock_recognition(uuid, text) TO authenticated;

-- ---------------------------------------------------------------- 4. the 7 items queued by Phase 3: recognised now
DO $recog$
DECLARE r record;
BEGIN
  FOR r IN SELECT q.id, s.order_status, s.issued_channel FROM public.merchandise_stock_recognitions q
           JOIN public.merchandise_sales s ON s.id = q.sale_id
           WHERE q.status = 'pending' AND q.origin = 'historical_20261104' ORDER BY q.created_at, q.id LOOP
    PERFORM public._merch_post_stock_recognition(r.id, 'order_issued',
      'order marked ' || r.order_status || ' 24-25 Sep 2026; recognised under the CFO policy of 2026-11-04', NULL);
  END LOOP;
END $recog$;

-- ---------------------------------------------------------------- post-check
DO $post$
DECLARE v_n int; v_amt numeric;
BEGIN
  SELECT count(*), COALESCE(sum(amt), 0) INTO v_n, v_amt FROM (
    SELECT g.transaction_group_id, sum(g.amount) FILTER (WHERE g.direction = 'cash_in') amt
    FROM public.general_ledger g
    JOIN public.ledger_account_map m ON m.ledger_scope = g.ledger_scope AND m.category = g.category AND m.wallet_bucket IS NULL
    WHERE g.idempotency_key LIKE 'merch\_stock\_recog:%'
    GROUP BY 1
    HAVING count(*) = 2 AND bool_and(g.ledger_scope = 'platform')
       AND sum(CASE WHEN g.direction = m.debit_when THEN g.amount ELSE -g.amount END) = 0
       AND sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) = 0
       AND bool_or(m.account_code = 'A12') AND bool_or(m.account_code = 'R1')) z;
  IF v_n <> 7 OR v_amt <> 1015000 THEN
    RAISE EXCEPTION 'stock on issue: post-check failed (% groups, %)', v_n, v_amt;
  END IF;
  IF EXISTS (SELECT 1 FROM public.merchandise_stock_recognitions WHERE status <> 'posted' OR evidence_kind <> 'order_issued')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key LIKE 'merch\_stock\_recog:%' AND ledger_scope = 'wallet') THEN
    RAISE EXCEPTION 'stock on issue: post-check failed (queue rows)';
  END IF;
  IF has_function_privilege('authenticated', 'public._merch_stock_on_issue(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._merch_post_stock_recognition(uuid, text, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cfo_post_merchandise_stock_recognition(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'stock on issue: grants not as intended';
  END IF;
END $post$;
