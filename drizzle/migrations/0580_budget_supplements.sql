-- Supplementary budgets: separate from original submissions and from any reallocation.
-- No ledger, wallet, payment or disbursement writes anywhere in this migration.

CREATE TABLE public.budget_supplements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE DEFAULT ('SUP-' || to_char(now() AT TIME ZONE 'Africa/Kampala','YYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text),1,6))),
  submission_id uuid NOT NULL REFERENCES public.budget_submissions(id),
  line_id uuid NOT NULL REFERENCES public.budget_submission_lines(id),
  department_id uuid NOT NULL,
  financial_year text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  justification text NOT NULL CHECK (length(btrim(justification)) >= 20),
  status text NOT NULL DEFAULT 'pending_cfo' CHECK (status IN ('pending_coo','pending_cfo','approved','rejected','cancelled')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  coo_decision text CHECK (coo_decision IN ('approved','rejected')),
  coo_decided_by uuid,
  coo_decided_at timestamptz,
  coo_note text,
  cfo_decision text CHECK (cfo_decision IN ('approved','rejected')),
  cfo_decided_by uuid,
  cfo_decided_at timestamptz,
  cfo_note text,
  approved_amount numeric CHECK (approved_amount IS NULL OR approved_amount > 0),
  cancelled_at timestamptz,
  cancel_note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_supp_approved_ck CHECK (
    (status = 'approved') = (approved_amount IS NOT NULL AND cfo_decision = 'approved')),
  CONSTRAINT budget_supp_sep_ck CHECK (
    coo_decided_by IS DISTINCT FROM requested_by AND cfo_decided_by IS DISTINCT FROM requested_by)
);
CREATE UNIQUE INDEX budget_supp_one_open_per_line ON public.budget_supplements(line_id)
  WHERE status IN ('pending_coo','pending_cfo');
CREATE INDEX budget_supp_submission_idx ON public.budget_supplements(submission_id);
CREATE INDEX budget_supp_status_idx ON public.budget_supplements(status);

CREATE TABLE public.budget_supplement_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplement_id uuid NOT NULL REFERENCES public.budget_supplements(id),
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.budget_supplement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplement_id uuid NOT NULL REFERENCES public.budget_supplements(id),
  event_type text NOT NULL,
  actor_user_id uuid,
  status_before text,
  status_after text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_supp_events_idx ON public.budget_supplement_events(supplement_id, created_at);

GRANT SELECT ON public.budget_supplements TO authenticated;
GRANT SELECT ON public.budget_supplement_documents TO authenticated;
GRANT SELECT ON public.budget_supplement_events TO authenticated;
GRANT ALL ON public.budget_supplements, public.budget_supplement_documents, public.budget_supplement_events TO service_role;

ALTER TABLE public.budget_supplements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_supplement_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_supplement_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.budget_supplement_can_read(_supplement_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM budget_supplements s
     WHERE s.id = _supplement_id
       AND ( s.requested_by = _user_id
          OR public.is_budget_reviewer(_user_id)
          OR public.budget_can_file_for_department(_user_id, s.department_id)
          OR (public.is_budget_coo_reviewer(_user_id) AND public.budget_department_route(s.department_id) = 'coo')
          OR public.has_role(_user_id,'super_admin') OR public.has_role(_user_id,'ceo')));
$$;

CREATE POLICY budget_supp_read ON public.budget_supplements FOR SELECT TO authenticated
  USING (public.budget_supplement_can_read(id, (SELECT auth.uid())));
CREATE POLICY budget_supp_docs_read ON public.budget_supplement_documents FOR SELECT TO authenticated
  USING (public.budget_supplement_can_read(supplement_id, (SELECT auth.uid())));
CREATE POLICY budget_supp_events_read ON public.budget_supplement_events FOR SELECT TO authenticated
  USING (public.budget_supplement_can_read(supplement_id, (SELECT auth.uid())));

-- Supporting documents for supplements live in the existing private budget-documents bucket.
CREATE POLICY "budget supplement docs read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'budget-documents' AND EXISTS (
    SELECT 1 FROM public.budget_supplement_documents d
     WHERE d.storage_path = objects.name
       AND public.budget_supplement_can_read(d.supplement_id, (SELECT auth.uid()))));

-- Append-only guard on the audit trail.
CREATE OR REPLACE FUNCTION public.budget_supplement_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Supplementary budget history is append-only'; END $$;
CREATE TRIGGER trg_budget_supp_events_append_only BEFORE UPDATE OR DELETE ON public.budget_supplement_events
  FOR EACH ROW EXECUTE FUNCTION public.budget_supplement_events_append_only();
CREATE TRIGGER trg_budget_supp_docs_append_only BEFORE UPDATE OR DELETE ON public.budget_supplement_documents
  FOR EACH ROW EXECUTE FUNCTION public.budget_supplement_events_append_only();

-- Terminal states are frozen; amount/line/requester never change after creation.
CREATE OR REPLACE FUNCTION public.budget_supplement_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Supplementary budgets cannot be deleted'; END IF;
  IF OLD.status IN ('approved','rejected','cancelled') THEN
    RAISE EXCEPTION 'Supplementary budget % is already %', OLD.reference, OLD.status;
  END IF;
  IF NEW.amount <> OLD.amount OR NEW.line_id <> OLD.line_id OR NEW.submission_id <> OLD.submission_id
     OR NEW.requested_by <> OLD.requested_by OR NEW.department_id <> OLD.department_id THEN
    RAISE EXCEPTION 'Supplementary budget request details cannot be changed';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_budget_supp_guard BEFORE UPDATE OR DELETE ON public.budget_supplements
  FOR EACH ROW EXECUTE FUNCTION public.budget_supplement_guard();

CREATE OR REPLACE FUNCTION public._budget_supplement_log(_s public.budget_supplements, _event text, _before text, _payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO budget_supplement_events(supplement_id, event_type, actor_user_id, status_before, status_after, payload)
  VALUES (_s.id, _event, auth.uid(), _before, _s.status, COALESCE(_payload,'{}'::jsonb));
  INSERT INTO system_events(event_type, user_id, actor_id, entity_type, entity_id, related_entity_type, related_entity_id, metadata, source)
  VALUES ('budget.supplement.' || _event, _s.requested_by, auth.uid(), 'budget_supplement', _s.id,
          'budget_submission', _s.submission_id,
          jsonb_build_object('reference', _s.reference, 'amount', _s.amount, 'status_before', _before,
                             'status_after', _s.status) || COALESCE(_payload,'{}'::jsonb), 'budget_supplements');
END $$;
REVOKE ALL ON FUNCTION public._budget_supplement_log(public.budget_supplements, text, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.budget_supplement_create(
  p_line_id uuid, p_amount numeric, p_justification text, p_financial_year text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_line budget_submission_lines; v_sub budget_submissions;
        v_fy text; v_s budget_supplements; v_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero'; END IF;
  IF p_justification IS NULL OR length(btrim(p_justification)) < 20 THEN
    RAISE EXCEPTION 'Provide a justification of at least 20 characters'; END IF;
  SELECT * INTO v_line FROM budget_submission_lines WHERE id = p_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'Budget line not found'; END IF;
  SELECT * INTO v_sub FROM budget_submissions WHERE id = v_line.submission_id FOR SHARE;
  IF v_sub.status <> 'approved' THEN RAISE EXCEPTION 'Supplements can only be requested on an approved budget'; END IF;
  IF v_line.status <> 'approved' THEN RAISE EXCEPTION 'Supplements can only be requested on an approved budget line'; END IF;
  IF NOT (public.budget_can_file_for_department(v_uid, v_sub.department_id)
          OR public.budget_is_department_head(v_sub.department_id, v_uid)) THEN
    RAISE EXCEPTION 'You cannot request a supplement for this department'; END IF;
  SELECT financial_year INTO v_fy FROM budget_calls WHERE id = v_sub.call_id;
  v_fy := COALESCE(NULLIF(btrim(p_financial_year),''), v_fy, to_char(now() AT TIME ZONE 'Africa/Kampala','YYYY'));
  v_status := CASE WHEN public.budget_department_route(v_sub.department_id) = 'coo' THEN 'pending_coo' ELSE 'pending_cfo' END;
  BEGIN
    INSERT INTO budget_supplements(submission_id, line_id, department_id, financial_year, amount, justification, status, requested_by)
    VALUES (v_sub.id, v_line.id, v_sub.department_id, v_fy, round(p_amount, 2), btrim(p_justification), v_status, v_uid)
    RETURNING * INTO v_s;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This budget line already has a supplement awaiting a decision';
  END;
  PERFORM public._budget_supplement_log(v_s, 'requested', NULL, jsonb_build_object('line_id', v_line.id));
  RETURN jsonb_build_object('id', v_s.id, 'reference', v_s.reference, 'status', v_s.status);
END $$;

CREATE OR REPLACE FUNCTION public.budget_supplement_add_document(p_supplement_id uuid, p_storage_path text, p_file_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_s budget_supplements; v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_s FROM budget_supplements WHERE id = p_supplement_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'Supplementary budget not found'; END IF;
  IF v_s.requested_by <> v_uid THEN RAISE EXCEPTION 'Only the requester can attach documents'; END IF;
  IF v_s.status NOT IN ('pending_coo','pending_cfo') THEN RAISE EXCEPTION 'Documents can only be added while awaiting a decision'; END IF;
  IF p_storage_path IS NULL OR p_storage_path NOT LIKE 'supplements/' || v_uid::text || '/%' THEN
    RAISE EXCEPTION 'Invalid document path'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'budget-documents' AND o.name = p_storage_path AND o.owner = v_uid) THEN
    RAISE EXCEPTION 'Upload the file first'; END IF;
  INSERT INTO budget_supplement_documents(supplement_id, storage_path, file_name, uploaded_by)
  VALUES (v_s.id, p_storage_path, left(COALESCE(NULLIF(btrim(p_file_name),''),'document'),200), v_uid) RETURNING id INTO v_id;
  PERFORM public._budget_supplement_log(v_s, 'document_added', v_s.status, jsonb_build_object('file_name', p_file_name));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.budget_supplement_cancel(p_supplement_id uuid, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_s budget_supplements; v_before text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 10 THEN RAISE EXCEPTION 'Provide a reason of at least 10 characters'; END IF;
  SELECT * INTO v_s FROM budget_supplements WHERE id = p_supplement_id FOR UPDATE;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'Supplementary budget not found'; END IF;
  IF v_s.requested_by <> v_uid THEN RAISE EXCEPTION 'Only the requester can cancel'; END IF;
  IF v_s.status NOT IN ('pending_coo','pending_cfo') THEN RAISE EXCEPTION 'This supplement is already %', v_s.status; END IF;
  v_before := v_s.status;
  UPDATE budget_supplements SET status = 'cancelled', cancelled_at = now(), cancel_note = btrim(p_note)
   WHERE id = v_s.id RETURNING * INTO v_s;
  PERFORM public._budget_supplement_log(v_s, 'cancelled', v_before, jsonb_build_object('note', btrim(p_note)));
  RETURN jsonb_build_object('id', v_s.id, 'status', v_s.status);
END $$;

CREATE OR REPLACE FUNCTION public.budget_supplement_coo_decide(p_supplement_id uuid, p_decision text, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_s budget_supplements; v_before text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  IF p_decision = 'rejected' AND (p_note IS NULL OR length(btrim(p_note)) < 10) THEN
    RAISE EXCEPTION 'Provide a rejection reason of at least 10 characters'; END IF;
  SELECT * INTO v_s FROM budget_supplements WHERE id = p_supplement_id FOR UPDATE;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'Supplementary budget not found'; END IF;
  IF v_s.status <> 'pending_coo' THEN RAISE EXCEPTION 'This supplement is not awaiting COO review (status %)', v_s.status; END IF;
  IF v_s.requested_by = v_uid THEN RAISE EXCEPTION 'You cannot review your own supplement'; END IF;
  IF NOT public.budget_may_first_level_act(v_uid, v_s.submission_id) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  v_before := v_s.status;
  UPDATE budget_supplements
     SET status = CASE WHEN p_decision = 'approved' THEN 'pending_cfo' ELSE 'rejected' END,
         coo_decision = p_decision, coo_decided_by = v_uid, coo_decided_at = now(),
         coo_note = NULLIF(btrim(COALESCE(p_note,'')),'')
   WHERE id = v_s.id RETURNING * INTO v_s;
  PERFORM public._budget_supplement_log(v_s, 'coo_' || p_decision, v_before, jsonb_build_object('note', p_note));
  PERFORM public.budget_notify(v_s.requested_by, 'Supplementary budget ' || p_decision || ' by COO',
     'Supplement ' || v_s.reference || ' was ' || p_decision || ' at COO review.', jsonb_build_object('supplement_id', v_s.id));
  RETURN jsonb_build_object('id', v_s.id, 'status', v_s.status);
END $$;

CREATE OR REPLACE FUNCTION public.budget_supplement_cfo_decide(
  p_supplement_id uuid, p_decision text, p_note text, p_approved_amount numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_s budget_supplements; v_before text; v_amt numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.is_cfo_approver(v_uid) AND public.is_budget_reviewer(v_uid)) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  IF p_decision = 'rejected' AND (p_note IS NULL OR length(btrim(p_note)) < 10) THEN
    RAISE EXCEPTION 'Provide a rejection reason of at least 10 characters'; END IF;
  SELECT * INTO v_s FROM budget_supplements WHERE id = p_supplement_id FOR UPDATE;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'Supplementary budget not found'; END IF;
  IF v_s.status <> 'pending_cfo' THEN RAISE EXCEPTION 'This supplement is not awaiting CFO approval (status %)', v_s.status; END IF;
  IF v_s.requested_by = v_uid THEN RAISE EXCEPTION 'You cannot approve your own supplement'; END IF;
  IF p_decision = 'approved' THEN
    v_amt := round(COALESCE(p_approved_amount, v_s.amount), 2);
    IF v_amt <= 0 OR v_amt > v_s.amount THEN RAISE EXCEPTION 'Approved amount must be above zero and not more than requested'; END IF;
    IF p_approved_amount IS NOT NULL AND v_amt < v_s.amount AND (p_note IS NULL OR length(btrim(p_note)) < 10) THEN
      RAISE EXCEPTION 'Explain the reduced amount in at least 10 characters'; END IF;
  END IF;
  v_before := v_s.status;
  UPDATE budget_supplements
     SET status = p_decision, cfo_decision = p_decision, cfo_decided_by = v_uid, cfo_decided_at = now(),
         cfo_note = NULLIF(btrim(COALESCE(p_note,'')),''),
         approved_amount = CASE WHEN p_decision = 'approved' THEN v_amt END
   WHERE id = v_s.id RETURNING * INTO v_s;
  PERFORM public._budget_supplement_log(v_s, 'cfo_' || p_decision, v_before,
     jsonb_build_object('note', p_note, 'approved_amount', v_s.approved_amount));
  PERFORM public.budget_notify(v_s.requested_by, 'Supplementary budget ' || p_decision,
     'Supplement ' || v_s.reference || ' was ' || p_decision || ' by the CFO.', jsonb_build_object('supplement_id', v_s.id));
  RETURN jsonb_build_object('id', v_s.id, 'status', v_s.status, 'approved_amount', v_s.approved_amount);
END $$;

CREATE OR REPLACE FUNCTION public.budget_supplement_list(p_status text DEFAULT NULL, p_call_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid, reference text, submission_id uuid, submission_reference text, line_id uuid,
  line_description text, account_code text, department_id uuid, department_name text, call_id uuid,
  financial_year text, amount numeric, approved_amount numeric, justification text, status text,
  requested_by uuid, requester_name text, requested_at timestamptz, coo_note text, cfo_note text,
  original_line_amount numeric, document_count int, can_coo_act boolean, can_cfo_act boolean, can_cancel boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.reference, s.submission_id, b.reference, s.line_id, l.description, l.account_code,
         s.department_id, d.name, b.call_id, s.financial_year, s.amount, s.approved_amount, s.justification,
         s.status, s.requested_by, p.full_name, s.requested_at, s.coo_note, s.cfo_note, l.approved_amount,
         (SELECT count(*)::int FROM budget_supplement_documents x WHERE x.supplement_id = s.id),
         (s.status = 'pending_coo' AND s.requested_by <> auth.uid() AND public.budget_may_first_level_act(auth.uid(), s.submission_id)),
         (s.status = 'pending_cfo' AND s.requested_by <> auth.uid() AND public.is_cfo_approver(auth.uid()) AND public.is_budget_reviewer(auth.uid())),
         (s.status IN ('pending_coo','pending_cfo') AND s.requested_by = auth.uid())
    FROM budget_supplements s
    JOIN budget_submissions b ON b.id = s.submission_id
    JOIN budget_submission_lines l ON l.id = s.line_id
    LEFT JOIN hr_departments d ON d.id = s.department_id
    LEFT JOIN profiles p ON p.id = s.requested_by
   WHERE auth.uid() IS NOT NULL
     AND public.budget_supplement_can_read(s.id, auth.uid())
     AND (p_status IS NULL OR s.status = p_status)
     AND (p_call_id IS NULL OR b.call_id = p_call_id)
   ORDER BY (s.status IN ('pending_coo','pending_cfo')) DESC, s.requested_at DESC
   LIMIT 500;
$$;

-- CFO report: original vs supplements vs revised vs actual vs remaining, per approved line.
-- Actual spending comes from the books per account code for the cycle period (company-wide per account).
CREATE OR REPLACE FUNCTION public.budget_revised_position(p_call_id uuid)
RETURNS TABLE(department_id uuid, department_name text, submission_id uuid, submission_reference text,
  line_id uuid, line_description text, account_code text, original_amount numeric,
  approved_supplements numeric, pending_supplements numeric, revised_amount numeric,
  actual_expenditure numeric, remaining_balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_call budget_calls;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.is_budget_reviewer(v_uid) OR public.is_budget_coo_reviewer(v_uid)
          OR public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'coo')
          OR public.has_role(v_uid,'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT * INTO v_call FROM budget_calls WHERE id = p_call_id;
  IF v_call.id IS NULL THEN RAISE EXCEPTION 'Budget cycle not found'; END IF;
  RETURN QUERY
  WITH lines AS (
    SELECT b.department_id AS dept, b.id AS sub_id, b.reference AS sub_ref, l.id AS lid, l.description, l.account_code,
           COALESCE(l.approved_amount,0) AS original
      FROM budget_submissions b JOIN budget_submission_lines l ON l.submission_id = b.id
     WHERE b.call_id = p_call_id AND b.status = 'approved' AND l.status = 'approved'),
  supp AS (
    SELECT s.line_id,
           SUM(CASE WHEN s.status = 'approved' THEN s.approved_amount ELSE 0 END) AS appr,
           SUM(CASE WHEN s.status IN ('pending_coo','pending_cfo') THEN s.amount ELSE 0 END) AS pend
      FROM budget_supplements s WHERE s.line_id IN (SELECT lid FROM lines) GROUP BY s.line_id),
  act AS (
    SELECT a.account_code, a.actual FROM public.budget_actuals_by_account(
      (v_call.period_start::timestamp AT TIME ZONE 'Africa/Kampala'),
      ((v_call.period_end + 1)::timestamp AT TIME ZONE 'Africa/Kampala') - interval '1 microsecond') a)
  SELECT ln.dept, d.name, ln.sub_id, ln.sub_ref, ln.lid, ln.description, ln.account_code, ln.original,
         COALESCE(sp.appr,0), COALESCE(sp.pend,0), ln.original + COALESCE(sp.appr,0),
         COALESCE(ac.actual,0), ln.original + COALESCE(sp.appr,0) - COALESCE(ac.actual,0)
    FROM lines ln
    LEFT JOIN supp sp ON sp.line_id = ln.lid
    LEFT JOIN act ac ON ac.account_code = ln.account_code
    LEFT JOIN hr_departments d ON d.id = ln.dept
   ORDER BY d.name, ln.sub_ref, ln.description;
END $$;

REVOKE ALL ON FUNCTION public.budget_supplement_create(uuid, numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.budget_supplement_add_document(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.budget_supplement_cancel(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.budget_supplement_coo_decide(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.budget_supplement_cfo_decide(uuid, text, text, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.budget_supplement_list(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.budget_revised_position(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_supplement_create(uuid, numeric, text, text),
  public.budget_supplement_add_document(uuid, text, text), public.budget_supplement_cancel(uuid, text),
  public.budget_supplement_coo_decide(uuid, text, text), public.budget_supplement_cfo_decide(uuid, text, text, numeric),
  public.budget_supplement_list(text, uuid), public.budget_revised_position(uuid),
  public.budget_supplement_can_read(uuid, uuid) TO authenticated;
