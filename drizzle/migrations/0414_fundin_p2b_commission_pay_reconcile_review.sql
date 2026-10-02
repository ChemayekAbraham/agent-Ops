-- FUNDIN-P2B. Approved: Bwayo (HR Lead), 2 Oct 2026, on executive authority.
-- Adds the pay, reconcile and review functions. Nothing calls them until P2C.
DO $pre$
BEGIN
  IF to_regprocedure('public.commission_resolve_earner(uuid,timestamp with time zone,boolean)') IS NULL
     OR to_regclass('public.commission_fund_ins') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAIL: FUNDIN-P2A not applied';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.commission_pay_fund_in(p_fund_in_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE
  fi public.commission_fund_ins%ROWTYPE;
  v_e uuid; v_path text; v_note uuid; v_asg uuid; v_basis text;
  v_kind text; v_rate numeric; v_amt numeric; v_idem text; v_group uuid; v_label text; v_legacy uuid;
BEGIN
  SELECT * INTO fi FROM public.commission_fund_ins WHERE id = p_fund_in_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','skipped','reason','not_found'); END IF;
  IF fi.status <> 'unattributed' THEN RETURN jsonb_build_object('status','skipped','reason','status_' || fi.status); END IF;

  UPDATE public.commission_fund_ins SET attempts = attempts + 1, last_attempt_at = now() WHERE id = fi.id;

  SELECT r.earner_id, r.earner_path, r.note_id, r.assignment_id, r.basis
    INTO v_e, v_path, v_note, v_asg, v_basis
    FROM public.commission_resolve_earner(fi.partner_id, fi.occurred_at, true) r LIMIT 1;
  IF v_e IS NULL THEN RETURN jsonb_build_object('status','skipped','reason','no_earner_yet'); END IF;

  v_kind := CASE WHEN public.commission_partner_has_prior_fund_in(fi.partner_id, fi.fund_in_key, fi.occurred_at)
                 THEN 'portfolio_topup' ELSE 'portfolio_creation' END;
  v_rate := public.promissory_commission_rate(v_kind, fi.occurred_at);
  IF coalesce(v_rate,0) <= 0 THEN RETURN jsonb_build_object('status','skipped','reason','no_rate_in_force'); END IF;

  v_amt := round(fi.amount * v_rate);
  IF v_amt <= 0 THEN
    UPDATE public.commission_fund_ins SET status = 'not_commissionable' WHERE id = fi.id;
    RETURN jsonb_build_object('status','skipped','reason','amount_rounds_to_zero');
  END IF;

  v_idem := 'fund_in_commission:' || fi.fund_in_key;
  IF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = v_idem) THEN
    RAISE EXCEPTION 'fund-in % already has a commission posting', fi.fund_in_key;
  END IF;

  v_label := CASE v_kind WHEN 'portfolio_creation' THEN 'Partner first fund-in commission ('
                         ELSE 'Partner repeat fund-in commission (' END
             || rtrim(to_char(v_rate * 100, 'FM990.99'), '.') || '%)';

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object('user_id', v_e, 'amount', v_amt, 'direction','cash_out',
        'category','marketing_expense', 'source_table', fi.source_table, 'source_id', fi.source_id::text,
        'reference_id', v_idem, 'linked_party', fi.partner_id::text,
        'description', 'Marketing expense: ' || v_label, 'ledger_scope','platform'),
      jsonb_build_object('user_id', v_e, 'amount', v_amt, 'direction','cash_in',
        'category', CASE WHEN v_path = 'managed_proxy' THEN 'partner_commission' ELSE 'agent_commission' END,
        'source_table', fi.source_table, 'source_id', fi.source_id::text,
        'reference_id', v_idem, 'linked_party', fi.partner_id::text,
        'description', v_label, 'ledger_scope','wallet', 'recipient_type','user')),
    v_idem);

  IF v_path = 'managed_proxy' THEN
    INSERT INTO public.proxy_commission_queue
      (kind, agent_id, partner_id, assignment_id, base_amount, rate, amount, source_table, source_id,
       idempotency_key, status, auto_approved, decided_at, decision_note, ledger_group_id)
    VALUES (v_kind, v_e, fi.partner_id, v_asg, fi.amount, v_rate, v_amt, fi.source_table, fi.source_id::text,
       v_idem, 'paid', true, now(), 'fund_in_gate', v_group)
    RETURNING id INTO v_legacy;
  ELSE
    INSERT INTO public.promissory_commission_events
      (note_id, agent_id, partner_id, kind, base_amount, rate, amount, source_table, source_id,
       idempotency_key, ledger_group_id, status)
    VALUES (v_note, v_e, fi.partner_id, v_kind, fi.amount, v_rate, v_amt, fi.source_table, fi.source_id::text,
       v_idem, v_group, 'paid')
    RETURNING id INTO v_legacy;
  END IF;

  INSERT INTO public.system_events (event_type, user_id, entity_type, entity_id, metadata)
  VALUES ('wallet_transfer', v_e, 'commission_fund_ins', fi.id,
    jsonb_build_object('fund_in_key', fi.fund_in_key, 'partner_id', fi.partner_id, 'earner_path', v_path,
      'basis', v_basis, 'kind', v_kind, 'base_amount', fi.amount, 'rate', v_rate, 'commission_amount', v_amt,
      'idempotency_key', v_idem, 'ledger_group_id', v_group));

  UPDATE public.commission_fund_ins
     SET status = 'paid', earner_id = v_e, earner_path = v_path, note_id = v_note, assignment_id = v_asg,
         kind = v_kind, rate = v_rate, commission = v_amt, ledger_group_id = v_group,
         legacy_table = CASE WHEN v_path = 'managed_proxy' THEN 'proxy_commission_queue' ELSE 'promissory_commission_events' END,
         legacy_id = v_legacy, paid_at = now()
   WHERE id = fi.id;

  RETURN jsonb_build_object('status','paid','amount',v_amt,'rate',v_rate,'kind',v_kind,
                            'earner_id',v_e,'earner_path',v_path,'basis',v_basis,'ledger_group_id',v_group);
END $f$;

CREATE OR REPLACE FUNCTION public.commission_reconcile_fund_ins(p_limit integer DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE
  c record; p record; v_id uuid; v_key text; v_src uuid; v_res jsonb;
  n_fund int := 0; n_merged int := 0; n_roi int := 0; n_review int := 0; n_cancel int := 0; n_wait int := 0; n_paid int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('commission_reconcile_fund_ins')) THEN
    RETURN jsonb_build_object('status','skipped','reason','already_running');
  END IF;

  FOR c IN SELECT * FROM public.commission_fund_in_candidates
            WHERE state = 'pending' ORDER BY observed_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    v_id := NULL;
    IF c.event IN ('portfolio_activation','self_commitment') THEN
      IF c.event = 'portfolio_activation' AND NOT EXISTS (
           SELECT 1 FROM public.investor_portfolios ip WHERE ip.id = c.portfolio_id AND ip.status IN ('active','locked')) THEN
        UPDATE public.commission_fund_in_candidates SET state = 'cancelled', note = 'portfolio no longer active' WHERE id = c.id;
        n_cancel := n_cancel + 1; CONTINUE;
      END IF;
      SELECT f.id INTO v_id FROM public.commission_fund_ins f
       WHERE f.partner_id = c.partner_id AND f.amount = c.amount
         AND split_part(f.fund_in_key, ':', 1) IN ('pf','psc')
         AND abs(extract(epoch FROM f.occurred_at - c.observed_at)) < 86400
       LIMIT 1;
      IF v_id IS NOT NULL THEN
        UPDATE public.commission_fund_in_candidates SET state = 'merged', fund_in_id = v_id,
               note = 'same partner and amount as an existing activation within 24h' WHERE id = c.id;
        n_merged := n_merged + 1; CONTINUE;
      END IF;
      v_key := CASE c.event WHEN 'portfolio_activation' THEN 'pf:' ELSE 'psc:' END || c.source_key;
      v_src := c.source_key::uuid;

    ELSIF c.event IN ('topup_completed','self_topup') THEN
      IF c.observed_at > now() - interval '30 minutes' THEN n_wait := n_wait + 1; CONTINUE; END IF;
      IF c.event = 'topup_completed' AND NOT EXISTS (
           SELECT 1 FROM public.pending_wallet_operations w WHERE w.id = c.source_key::uuid AND w.status = 'completed') THEN
        UPDATE public.commission_fund_in_candidates SET state = 'cancelled', note = 'top-up no longer completed' WHERE id = c.id;
        n_cancel := n_cancel + 1; CONTINUE;
      END IF;
      SELECT f.id INTO v_id FROM public.commission_fund_ins f
       WHERE f.partner_id = c.partner_id AND f.amount = c.amount
         AND split_part(f.fund_in_key, ':', 1) IN ('pwo','pst')
         AND abs(extract(epoch FROM f.occurred_at - c.observed_at)) < 86400
       LIMIT 1;
      IF v_id IS NOT NULL THEN
        UPDATE public.commission_fund_in_candidates SET state = 'merged', fund_in_id = v_id,
               note = 'same partner and amount as an existing top-up within 24h' WHERE id = c.id;
        n_merged := n_merged + 1; CONTINUE;
      END IF;
      v_key := CASE c.event WHEN 'topup_completed' THEN 'pwo:' ELSE 'pst:' END || c.source_key;
      v_src := c.source_key::uuid;

    ELSE
      IF c.observed_at > now() - interval '2 hours' THEN n_wait := n_wait + 1; CONTINUE; END IF;
      SELECT f.id INTO v_id FROM public.commission_fund_ins f
       WHERE f.partner_id = c.partner_id AND f.amount = c.amount
         AND split_part(f.fund_in_key, ':', 1) IN ('pwo','pst')
         AND (f.portfolio_id IS NULL OR f.portfolio_id = c.portfolio_id)
         AND f.occurred_at BETWEEN c.observed_at - interval '35 days' AND c.observed_at + interval '2 hours'
       ORDER BY f.occurred_at DESC LIMIT 1;
      IF v_id IS NOT NULL THEN
        UPDATE public.commission_fund_in_candidates SET state = 'merged', fund_in_id = v_id,
               note = 'principal increase is a top-up already counted' WHERE id = c.id;
        n_merged := n_merged + 1; CONTINUE;
      END IF;
      IF EXISTS (SELECT 1 FROM public.pending_wallet_operations w
                  WHERE w.operation_type = 'portfolio_topup' AND w.status = 'completed'
                    AND w.source_table = 'investor_portfolios' AND w.source_id = c.portfolio_id AND w.amount = c.amount
                    AND w.updated_at BETWEEN c.observed_at - interval '35 days' AND c.observed_at + interval '2 hours') THEN
        UPDATE public.commission_fund_in_candidates SET state = 'merged',
               note = 'matches a completed top-up (pre-gate or parked until ROI)' WHERE id = c.id;
        n_merged := n_merged + 1; CONTINUE;
      END IF;
      IF EXISTS (SELECT 1 FROM public.general_ledger g
                  WHERE g.user_id = c.partner_id AND g.category IN ('roi_reinvestment','roi_expense')
                    AND g.amount = c.amount
                    AND g.transaction_date BETWEEN c.observed_at - interval '1 day' AND c.observed_at + interval '1 day') THEN
        UPDATE public.commission_fund_in_candidates SET state = 'roi', note = 'ROI compounding — not a fund-in' WHERE id = c.id;
        n_roi := n_roi + 1; CONTINUE;
      END IF;
      UPDATE public.commission_fund_in_candidates SET state = 'needs_review',
             note = 'principal increase with no matching top-up or ROI record (e.g. renewal top-up, manual edit)' WHERE id = c.id;
      n_review := n_review + 1; CONTINUE;
    END IF;

    INSERT INTO public.commission_fund_ins (fund_in_key, partner_id, portfolio_id, source_table, source_id, amount, occurred_at)
    VALUES (v_key, c.partner_id, c.portfolio_id, c.source_table, v_src, c.amount, c.observed_at)
    ON CONFLICT (fund_in_key) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN SELECT id INTO v_id FROM public.commission_fund_ins WHERE fund_in_key = v_key; END IF;
    UPDATE public.commission_fund_in_candidates SET state = 'fund_in', fund_in_id = v_id WHERE id = c.id;
    n_fund := n_fund + 1;
  END LOOP;

  FOR p IN SELECT id FROM public.commission_fund_ins
            WHERE status = 'unattributed' AND created_at > now() - interval '60 days'
            ORDER BY occurred_at LIMIT p_limit
  LOOP
    BEGIN
      v_res := public.commission_pay_fund_in(p.id);
      IF v_res->>'status' = 'paid' THEN n_paid := n_paid + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.commission_gate_errors (context, detail, error)
      VALUES ('pay', jsonb_build_object('fund_in_id', p.id), sqlerrm);
    END;
  END LOOP;

  UPDATE public.commission_fund_ins SET status = 'no_earner'
   WHERE status = 'unattributed' AND created_at <= now() - interval '60 days';

  RETURN jsonb_build_object('status','ok','fund_ins',n_fund,'merged',n_merged,'roi',n_roi,
    'needs_review',n_review,'cancelled',n_cancel,'waiting',n_wait,'paid',n_paid);
END $f$;

CREATE OR REPLACE FUNCTION public.commission_review_candidate(p_candidate_id uuid, p_decision text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE c public.commission_fund_in_candidates%ROWTYPE; v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = auth.uid() AND ur.enabled = true
                    AND ur.role = ANY (ARRAY['cfo'::app_role,'ceo'::app_role])) THEN
    RAISE EXCEPTION 'commission_review_candidate: CFO or CEO only';
  END IF;
  IF p_decision NOT IN ('fund_in','not_commissionable') THEN
    RAISE EXCEPTION 'decision must be fund_in or not_commissionable';
  END IF;
  IF length(trim(coalesce(p_reason,''))) < 10 THEN
    RAISE EXCEPTION 'a reason of at least 10 characters is required';
  END IF;
  SELECT * INTO c FROM public.commission_fund_in_candidates WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND OR c.state <> 'needs_review' THEN RAISE EXCEPTION 'candidate is not awaiting review'; END IF;

  IF p_decision = 'not_commissionable' THEN
    UPDATE public.commission_fund_in_candidates
       SET state = 'not_commissionable', note = p_reason, decided_by = auth.uid(), decided_at = now()
     WHERE id = c.id;
    RETURN jsonb_build_object('status','closed');
  END IF;

  INSERT INTO public.commission_fund_ins (fund_in_key, partner_id, portfolio_id, source_table, source_id, amount, occurred_at)
  VALUES ('pfi:' || c.source_key, c.partner_id, c.portfolio_id, 'investor_portfolios', c.portfolio_id, c.amount, c.observed_at)
  RETURNING id INTO v_id;
  UPDATE public.commission_fund_in_candidates
     SET state = 'fund_in', fund_in_id = v_id, note = p_reason, decided_by = auth.uid(), decided_at = now()
   WHERE id = c.id;
  RETURN public.commission_pay_fund_in(v_id);
END $f$;

REVOKE ALL ON FUNCTION public.commission_pay_fund_in(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commission_reconcile_fund_ins(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commission_review_candidate(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commission_review_candidate(uuid,text,text) TO authenticated;