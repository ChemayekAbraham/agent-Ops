-- Stage 14 — Evidence Recovery & Case Resolution. Evidence/decision tables only; no financial writes.
CREATE TABLE public.fin_s14_cases (
  collection_id uuid PRIMARY KEY REFERENCES public.fin_collection_reconciliation_s11(collection_id),
  case_type text NOT NULL CHECK (case_type IN ('duplicate','agent_mismatch')),
  status text NOT NULL DEFAULT 'Awaiting Evidence Recovery' CHECK (status IN ('Awaiting Evidence Recovery','Evidence Collected','Confirmed Duplicate','Valid Separate Payment','Confirmed Agent Mismatch','Confirmed Genuine','Insufficient Evidence')),
  correction_status text NOT NULL DEFAULT 'Not Ready' CHECK (correction_status IN ('Not Ready','Ready for Correction Review','Resolved / No Correction')),
  confirmed_agent_id uuid,
  valid_original_id uuid,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.fin_s14_cases (collection_id, case_type)
SELECT r.collection_id, CASE WHEN r.reconciliation_result = 'System duplicate candidate' THEN 'duplicate' ELSE 'agent_mismatch' END
FROM public.fin_collection_reconciliation_s11 r JOIN public.fin_collection_evidence_s12 e USING (collection_id)
WHERE e.evidence_status = 'Unresolved' AND r.reconciliation_result IN ('System duplicate candidate','System-inconsistent');

CREATE TABLE public.fin_s14_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES public.fin_s14_cases(collection_id),
  evidence_type text NOT NULL CHECK (evidence_type IN ('Tenant confirmation','Agent receipt','Cash handover record','Mobile-money/payment reference','Deposit evidence','Uploaded document','Other independently verifiable evidence')),
  evidence_date date NOT NULL,
  evidence_source text NOT NULL,
  reference_number text,
  contact_person text,
  contact_date date,
  contact_method text,
  notes text NOT NULL,
  attachment_path text,
  tenant_confirmation jsonb,
  reviewer uuid NOT NULL,
  reviewer_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.fin_s14_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage text NOT NULL DEFAULT 'Stage 14',
  collection_id uuid NOT NULL REFERENCES public.fin_s14_cases(collection_id),
  action text NOT NULL CHECK (action IN ('evidence_recorded','decision')),
  previous_status text NOT NULL,
  new_status text NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  evidence_refs text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL,
  reviewer uuid NOT NULL,
  reviewer_role text NOT NULL,
  financial_records_changed boolean NOT NULL DEFAULT false,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.fin_s14_cases, public.fin_s14_evidence, public.fin_s14_audit TO authenticated;
GRANT ALL ON public.fin_s14_cases, public.fin_s14_evidence, public.fin_s14_audit TO service_role;
ALTER TABLE public.fin_s14_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_s14_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_s14_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CFO approvers read S14 cases" ON public.fin_s14_cases FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));
CREATE POLICY "CFO approvers read S14 evidence" ON public.fin_s14_evidence FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));
CREATE POLICY "CFO approvers read S14 audit" ON public.fin_s14_audit FOR SELECT TO authenticated USING (public.is_cfo_approver(auth.uid()));

CREATE OR REPLACE FUNCTION public.fin_s14_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $f$
BEGIN RAISE EXCEPTION 'Stage 14 % is append-only', TG_TABLE_NAME; END $f$;
CREATE TRIGGER trg_fin_s14_evidence_append_only BEFORE UPDATE OR DELETE ON public.fin_s14_evidence FOR EACH ROW EXECUTE FUNCTION public.fin_s14_append_only();
CREATE TRIGGER trg_fin_s14_audit_append_only BEFORE UPDATE OR DELETE ON public.fin_s14_audit FOR EACH ROW EXECUTE FUNCTION public.fin_s14_append_only();
CREATE TRIGGER trg_fin_s14_cases_no_delete BEFORE DELETE ON public.fin_s14_cases FOR EACH ROW EXECUTE FUNCTION public.fin_s14_append_only();

CREATE OR REPLACE FUNCTION public.fin_s14_txn_financial_writes()
 RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del),0)::bigint FROM pg_stat_xact_user_tables
  WHERE schemaname='public' AND relname IN ('general_ledger','wallets_physical','wallet_balances_projection','wallet_transactions',
   'agent_collections','rent_requests','agent_landlord_float','agent_landlord_float_allocations','agent_float_withdrawals',
   'agent_tenant_float_reversals','agent_commission_payouts','commission_accrual_ledger','commission_fund_ins','commission_recompute_settlements',
   'proxy_payout_settlements','deposit_requests','withdrawal_requests','landlord_payouts','agent_landlord_payouts')
$f$;

CREATE OR REPLACE FUNCTION public.fin_s14_assert_controls()
 RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE n int; a numeric;
BEGIN
  PERFORM public.fin_s12_assert_controls();
  SELECT count(*), coalesce(sum(r.amount),0) INTO n, a FROM public.fin_collection_reconciliation_s11 r JOIN public.fin_collection_evidence_s12 e USING (collection_id)
   WHERE e.evidence_status='Unresolved' AND r.reconciliation_result='System duplicate candidate';
  IF n <> 253 OR a <> 23231059 THEN RAISE EXCEPTION 'Stage 12 duplicate unresolved changed (% / UGX %) — Stage 14 locked', n, a; END IF;
  SELECT count(*), coalesce(sum(r.amount),0) INTO n, a FROM public.fin_collection_reconciliation_s11 r JOIN public.fin_collection_evidence_s12 e USING (collection_id)
   WHERE e.evidence_status='Unresolved' AND r.reconciliation_result='System-inconsistent';
  IF n <> 14 OR a <> 1684334 THEN RAISE EXCEPTION 'Stage 12 agent-mismatch unresolved changed (% / UGX %) — Stage 14 locked', n, a; END IF;
  SELECT count(*), coalesce(sum(r.amount),0) INTO n, a FROM public.fin_s14_cases c JOIN public.fin_collection_reconciliation_s11 r USING (collection_id)
   JOIN public.fin_collection_evidence_s12 e USING (collection_id) WHERE e.evidence_status='Unresolved';
  IF n <> 267 OR a <> 24915393 THEN RAISE EXCEPTION 'Stage 14 population changed (% / UGX %) — Stage 14 locked', n, a; END IF;
  SELECT count(*) INTO n FROM public.fin_s14_cases;
  IF n <> 267 THEN RAISE EXCEPTION 'Stage 14 case table changed (% cases) — Stage 14 locked', n; END IF;
END $f$;
REVOKE ALL ON FUNCTION public.fin_s14_txn_financial_writes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_s14_assert_controls() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cfo_s14_list()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE r jsonb;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  PERFORM public.fin_s14_assert_controls();
  SELECT jsonb_build_object(
    'controls', jsonb_build_object(
      'stage11_count', (SELECT count(*) FROM public.fin_collection_reconciliation_s11),
      'stage11_amount', (SELECT sum(amount) FROM public.fin_collection_reconciliation_s11),
      'population_count', (SELECT count(*) FROM public.fin_s14_cases),
      'population_amount', (SELECT sum(r.amount) FROM public.fin_s14_cases c JOIN public.fin_collection_reconciliation_s11 r USING (collection_id)),
      'evidence_items', (SELECT count(*) FROM public.fin_s14_evidence),
      'decisions', (SELECT count(*) FROM public.fin_s14_audit WHERE action='decision'),
      'financial_writes_this_txn', public.fin_s14_txn_financial_writes()),
    'cases', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'collection_id', s.collection_id, 'collected_at', s.collected_at, 'case_type', c.case_type,
      'tenant_name', s.tenant_name, 'tenant_phone', tp.phone, 'rent_plan_id', s.rent_plan_id, 'amount', s.amount,
      'agent_id', s.agent_id, 'agent_name', s.agent_name, 'plan_agent_id', rr.agent_id, 'plan_agent_name', pa.full_name,
      'stage11', s.reconciliation_result, 'stage12', e.evidence_status, 'reversed_at', s.reversed_at,
      'status', c.status, 'correction_status', c.correction_status, 'confirmed_agent_id', c.confirmed_agent_id,
      'valid_original_id', c.valid_original_id, 'decided_at', c.decided_at,
      'ledger_receipt', s.ledger_receipt, 'ledger_repayment', s.ledger_repayment, 'ledger_commission', s.ledger_commission,
      'evidence', coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.created_at) FROM public.fin_s14_evidence v WHERE v.collection_id = c.collection_id), '[]'::jsonb),
      'matches', CASE WHEN c.case_type='duplicate' THEN coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', o.id, 'collected_at', o.created_at, 'agent_name', op.full_name,
          'seconds_apart', round(extract(epoch FROM o.created_at - s.collected_at)), 'reversed_at', o.reversed_at,
          'in_population', EXISTS (SELECT 1 FROM public.fin_collection_reconciliation_s11 x WHERE x.collection_id = o.id)) ORDER BY o.created_at)
        FROM public.agent_collections o LEFT JOIN public.profiles op ON op.id = o.agent_id
        WHERE o.id <> s.collection_id AND o.agent_id = s.agent_id AND o.tenant_id IS NOT DISTINCT FROM s.tenant_id
          AND o.rent_request_id IS NOT DISTINCT FROM s.rent_plan_id AND o.amount = s.amount
          AND abs(extract(epoch FROM o.created_at - s.collected_at)) <= 1800), '[]'::jsonb) ELSE '[]'::jsonb END
      ) ORDER BY s.collected_at)
      FROM public.fin_s14_cases c
      JOIN public.fin_collection_reconciliation_s11 s USING (collection_id)
      JOIN public.fin_collection_evidence_s12 e USING (collection_id)
      LEFT JOIN public.profiles tp ON tp.id = s.tenant_id
      LEFT JOIN public.rent_requests rr ON rr.id = s.rent_plan_id
      LEFT JOIN public.profiles pa ON pa.id = rr.agent_id), '[]'::jsonb)
  ) INTO r;
  RETURN r;
END $f$;

CREATE OR REPLACE FUNCTION public.cfo_s14_add_evidence(p_collection_id uuid, p_item jsonb)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_fin bigint; c public.fin_s14_cases%ROWTYPE; v_type text; v_path text; v_tc jsonb; v_id uuid; v_new text; v_ans text;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  PERFORM public.fin_s14_assert_controls();
  v_fin := public.fin_s14_txn_financial_writes();
  IF v_fin <> 0 THEN RAISE EXCEPTION 'Financial records were already written in this transaction — refused'; END IF;
  SELECT * INTO c FROM public.fin_s14_cases WHERE collection_id = p_collection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Collection is not in the Stage 14 population'; END IF;
  IF c.status NOT IN ('Awaiting Evidence Recovery','Evidence Collected') THEN RAISE EXCEPTION 'This case already has a Stage 14 outcome; evidence is closed'; END IF;
  v_type := p_item->>'evidence_type';
  IF v_type IS NULL OR v_type NOT IN ('Tenant confirmation','Agent receipt','Cash handover record','Mobile-money/payment reference','Deposit evidence','Uploaded document','Other independently verifiable evidence') THEN RAISE EXCEPTION 'Unknown evidence type'; END IF;
  IF nullif(p_item->>'evidence_date','') IS NULL THEN RAISE EXCEPTION 'Evidence date is required'; END IF;
  IF nullif(trim(p_item->>'evidence_source'),'') IS NULL THEN RAISE EXCEPTION 'Evidence source is required'; END IF;
  IF length(coalesce(trim(p_item->>'notes'),'')) < 10 THEN RAISE EXCEPTION 'Notes must be at least 10 characters'; END IF;
  v_path := nullif(p_item->>'attachment_path','');
  IF v_path IS NOT NULL THEN
    IF v_path !~ ('^' || p_collection_id::text || '/s14/[A-Za-z0-9._-]+$') THEN RAISE EXCEPTION 'Evidence file must be in this collection''s own Stage 14 evidence folder'; END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects so WHERE so.bucket_id = 'collection-evidence' AND so.name = v_path) THEN RAISE EXCEPTION 'Evidence file not found in the private evidence folder'; END IF;
    IF EXISTS (SELECT 1 FROM public.fin_s14_evidence WHERE attachment_path = v_path) THEN RAISE EXCEPTION 'This file is already attached to an evidence item'; END IF;
  END IF;
  IF v_type = 'Uploaded document' AND v_path IS NULL THEN RAISE EXCEPTION 'An uploaded document needs a file'; END IF;
  IF v_type IN ('Mobile-money/payment reference','Agent receipt','Deposit evidence') AND nullif(trim(p_item->>'reference_number'),'') IS NULL AND v_path IS NULL THEN
    RAISE EXCEPTION '% needs a reference number or a file', v_type;
  END IF;
  IF v_type = 'Tenant confirmation' THEN
    v_tc := p_item->'tenant_confirmation';
    IF v_tc IS NULL OR jsonb_typeof(v_tc) <> 'object' THEN RAISE EXCEPTION 'Tenant confirmation details are required'; END IF;
    IF nullif(trim(p_item->>'contact_person'),'') IS NULL OR nullif(p_item->>'contact_date','') IS NULL OR nullif(trim(p_item->>'contact_method'),'') IS NULL THEN
      RAISE EXCEPTION 'Tenant confirmation needs who was contacted, when and how';
    END IF;
    IF coalesce(v_tc->>'payment_made','') NOT IN ('Yes','No','Cannot say') THEN RAISE EXCEPTION 'Say whether payment was made'; END IF;
    v_ans := v_tc->>'answer';
    IF c.case_type = 'duplicate' AND coalesce(v_ans,'') NOT IN ('One payment','Two separate payments','More than two payments','Tenant cannot confirm') THEN
      RAISE EXCEPTION 'Answer: did the tenant make one payment or two separate payments?';
    END IF;
    IF c.case_type = 'agent_mismatch' AND coalesce(v_ans,'') NOT IN ('Recorded agent','Other agent','Cannot confirm') THEN
      RAISE EXCEPTION 'Answer: which agent did the tenant confirm receiving the payment?';
    END IF;
  ELSE v_tc := NULL; END IF;

  INSERT INTO public.fin_s14_evidence (collection_id, evidence_type, evidence_date, evidence_source, reference_number, contact_person, contact_date, contact_method, notes, attachment_path, tenant_confirmation, reviewer, reviewer_role)
  VALUES (p_collection_id, v_type, (p_item->>'evidence_date')::date, trim(p_item->>'evidence_source'), nullif(trim(p_item->>'reference_number'),''),
    nullif(trim(p_item->>'contact_person'),''), nullif(p_item->>'contact_date','')::date, nullif(trim(p_item->>'contact_method'),''),
    trim(p_item->>'notes'), v_path, v_tc, auth.uid(), 'CFO approver')
  RETURNING id INTO v_id;
  v_new := 'Evidence Collected';
  UPDATE public.fin_s14_cases SET status = v_new, updated_at = now() WHERE collection_id = p_collection_id;
  INSERT INTO public.fin_s14_audit (collection_id, action, previous_status, new_status, evidence_ids, evidence_refs, reason, reviewer, reviewer_role, details)
  VALUES (p_collection_id, 'evidence_recorded', c.status, v_new, ARRAY[v_id], ARRAY_REMOVE(ARRAY[nullif(trim(p_item->>'reference_number'),'')], NULL),
    'Evidence recorded: ' || v_type, auth.uid(), 'CFO approver', p_item);
  PERFORM public.fin_s14_assert_controls();
  IF public.fin_s14_txn_financial_writes() <> v_fin THEN RAISE EXCEPTION 'Evidence save touched a financial record — refused and rolled back'; END IF;
  RETURN v_id;
END $f$;

CREATE OR REPLACE FUNCTION public.cfo_s14_decide(p_collection_id uuid, p_outcome text, p_reason text, p_fields jsonb)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_fin bigint; c public.fin_s14_cases%ROWTYPE; s public.fin_collection_reconciliation_s11%ROWTYPE; o public.agent_collections%ROWTYPE;
  v_ids uuid[]; v_used int; v_support int; v_tc_yes int; v_tc_no int; v_agent uuid; v_orig uuid; v_corr text; v_refs text[];
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  PERFORM public.fin_s14_assert_controls();
  v_fin := public.fin_s14_txn_financial_writes();
  IF v_fin <> 0 THEN RAISE EXCEPTION 'Financial records were already written in this transaction — refused'; END IF;
  IF length(coalesce(trim(p_reason),'')) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;
  SELECT * INTO c FROM public.fin_s14_cases WHERE collection_id = p_collection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Collection is not in the Stage 14 population'; END IF;
  IF c.status NOT IN ('Awaiting Evidence Recovery','Evidence Collected') THEN RAISE EXCEPTION 'This case already has a Stage 14 outcome'; END IF;
  SELECT * INTO s FROM public.fin_collection_reconciliation_s11 WHERE collection_id = p_collection_id;
  IF c.case_type = 'duplicate' AND p_outcome NOT IN ('Confirmed Duplicate','Valid Separate Payment','Insufficient Evidence') THEN RAISE EXCEPTION 'Duplicate cases may only be Confirmed Duplicate, Valid Separate Payment or Insufficient Evidence'; END IF;
  IF c.case_type = 'agent_mismatch' AND p_outcome NOT IN ('Confirmed Agent Mismatch','Confirmed Genuine','Insufficient Evidence') THEN RAISE EXCEPTION 'Agent-mismatch cases may only be Confirmed Agent Mismatch, Confirmed Genuine or Insufficient Evidence'; END IF;

  v_ids := coalesce((SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_fields->'evidence_ids')='array' THEN p_fields->'evidence_ids' ELSE '[]'::jsonb END) x), '{}');
  SELECT count(*) INTO v_used FROM public.fin_s14_evidence WHERE id = ANY(v_ids) AND collection_id = p_collection_id;
  IF v_used <> coalesce(array_length(v_ids,1),0) THEN RAISE EXCEPTION 'Evidence used must belong to this case'; END IF;
  SELECT coalesce(array_agg(reference_number) FILTER (WHERE reference_number IS NOT NULL), '{}') INTO v_refs FROM public.fin_s14_evidence WHERE id = ANY(v_ids);

  IF p_outcome <> 'Insufficient Evidence' THEN
    IF v_used = 0 THEN RAISE EXCEPTION 'A confirmed outcome needs recorded Stage 14 evidence'; END IF;
    -- Supported = has a reference or a file, or is a structured tenant confirmation with contact details. Free text alone never counts.
    SELECT count(*) INTO v_support FROM public.fin_s14_evidence WHERE id = ANY(v_ids)
      AND (reference_number IS NOT NULL OR attachment_path IS NOT NULL);
    IF c.case_type = 'duplicate' THEN
      SELECT count(*) FILTER (WHERE tenant_confirmation->>'answer' = CASE WHEN p_outcome='Confirmed Duplicate' THEN 'One payment' ELSE 'x' END
                                OR (p_outcome='Valid Separate Payment' AND tenant_confirmation->>'answer' IN ('Two separate payments','More than two payments'))),
             count(*) FILTER (WHERE tenant_confirmation->>'answer' IN ('One payment','Two separate payments','More than two payments')
                                AND NOT (tenant_confirmation->>'answer' = CASE WHEN p_outcome='Confirmed Duplicate' THEN 'One payment' ELSE 'x' END
                                OR (p_outcome='Valid Separate Payment' AND tenant_confirmation->>'answer' IN ('Two separate payments','More than two payments'))))
        INTO v_tc_yes, v_tc_no FROM public.fin_s14_evidence WHERE collection_id = p_collection_id AND evidence_type='Tenant confirmation';
    ELSE
      SELECT count(*) FILTER (WHERE tenant_confirmation->>'answer' = CASE WHEN p_outcome='Confirmed Genuine' THEN 'Recorded agent' ELSE 'Other agent' END),
             count(*) FILTER (WHERE tenant_confirmation->>'answer' = CASE WHEN p_outcome='Confirmed Genuine' THEN 'Other agent' ELSE 'Recorded agent' END)
        INTO v_tc_yes, v_tc_no FROM public.fin_s14_evidence WHERE collection_id = p_collection_id AND evidence_type='Tenant confirmation';
    END IF;
    IF v_tc_no > 0 THEN RAISE EXCEPTION 'A recorded tenant confirmation contradicts this outcome — resolve the conflict or close as Insufficient Evidence'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.fin_s14_evidence WHERE id = ANY(v_ids) AND evidence_type='Tenant confirmation' AND (
        tenant_confirmation->>'answer' = CASE p_outcome WHEN 'Confirmed Duplicate' THEN 'One payment' WHEN 'Confirmed Genuine' THEN 'Recorded agent' WHEN 'Confirmed Agent Mismatch' THEN 'Other agent' ELSE 'x' END
        OR (p_outcome='Valid Separate Payment' AND tenant_confirmation->>'answer' IN ('Two separate payments','More than two payments')))) THEN
      RAISE EXCEPTION 'This outcome needs a tenant confirmation, used as evidence, that supports it';
    END IF;
    IF v_support = 0 THEN RAISE EXCEPTION 'This outcome also needs at least one corroborating item with a reference number or a file'; END IF;
  END IF;

  v_agent := nullif(p_fields->>'confirmed_agent_id','')::uuid;
  v_orig := nullif(p_fields->>'valid_original_id','')::uuid;
  IF p_outcome = 'Confirmed Agent Mismatch' THEN
    IF v_agent IS NULL THEN RAISE EXCEPTION 'Name the confirmed collecting agent'; END IF;
    IF v_agent = s.agent_id THEN RAISE EXCEPTION 'The confirmed agent is the recorded agent — that is Confirmed Genuine'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_agent) THEN RAISE EXCEPTION 'Confirmed agent not found'; END IF;
  ELSE v_agent := NULL; END IF;
  IF p_outcome = 'Confirmed Duplicate' THEN
    IF v_orig IS NULL OR v_orig = p_collection_id THEN RAISE EXCEPTION 'Name the valid original collection (a different collection)'; END IF;
    SELECT * INTO o FROM public.agent_collections WHERE id = v_orig;
    IF NOT FOUND THEN RAISE EXCEPTION 'Original collection not found'; END IF;
    IF o.tenant_id IS DISTINCT FROM s.tenant_id OR o.rent_request_id IS DISTINCT FROM s.rent_plan_id OR o.amount <> s.amount OR o.agent_id <> s.agent_id
       OR o.reversed_at IS NOT NULL OR abs(extract(epoch FROM o.created_at - s.collected_at)) > 1800 THEN
      RAISE EXCEPTION 'The original must be one of the listed, unreversed possible matches';
    END IF;
  ELSE v_orig := NULL; END IF;
  v_corr := CASE WHEN p_outcome IN ('Confirmed Duplicate','Confirmed Agent Mismatch') THEN 'Ready for Correction Review' ELSE 'Resolved / No Correction' END;

  UPDATE public.fin_s14_cases SET status = p_outcome, correction_status = v_corr, confirmed_agent_id = v_agent, valid_original_id = v_orig,
    decided_by = auth.uid(), decided_at = now(), updated_at = now() WHERE collection_id = p_collection_id;
  INSERT INTO public.fin_s14_audit (collection_id, action, previous_status, new_status, evidence_ids, evidence_refs, reason, reviewer, reviewer_role, details)
  VALUES (p_collection_id, 'decision', c.status, p_outcome, v_ids, v_refs, trim(p_reason), auth.uid(), 'CFO approver',
    p_fields || jsonb_build_object('correction_status', v_corr));
  PERFORM public.fin_s14_assert_controls();
  IF public.fin_s14_txn_financial_writes() <> v_fin THEN RAISE EXCEPTION 'Decision touched a financial record — refused and rolled back'; END IF;
END $f$;

CREATE OR REPLACE FUNCTION public.cfo_s14_history(p_collection_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN jsonb_build_object(
    'stage14', coalesce((SELECT jsonb_agg(to_jsonb(a) || jsonb_build_object('reviewer_name', p.full_name) ORDER BY a.created_at)
       FROM public.fin_s14_audit a LEFT JOIN public.profiles p ON p.id = a.reviewer WHERE a.collection_id = p_collection_id), '[]'::jsonb),
    'stage12', coalesce((SELECT jsonb_agg(jsonb_build_object('created_at', a.created_at, 'previous_status', a.previous_status, 'new_status', a.new_status, 'reason', a.reason, 'reviewer_name', p.full_name) ORDER BY a.created_at)
       FROM public.fin_collection_evidence_s12_audit a LEFT JOIN public.profiles p ON p.id = a.actor WHERE a.collection_id = p_collection_id), '[]'::jsonb));
END $f$;

REVOKE ALL ON FUNCTION public.cfo_s14_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_s14_add_evidence(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_s14_decide(uuid, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_s14_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_s14_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_s14_add_evidence(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_s14_decide(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_s14_history(uuid) TO authenticated;