-- ============ Stage 1: Department Budget Collection & CFO Approval (schema) ============
-- Extends existing budget_* structures without dropping anything.

-- 1. Budget cycles (calls)
ALTER TABLE public.budget_calls
  ADD COLUMN IF NOT EXISTS financial_year text,
  ADD COLUMN IF NOT EXISTS instructions text;
ALTER TABLE public.budget_calls ALTER COLUMN issued_by_position_id DROP NOT NULL;

-- 2. Submissions: versioning, review, lateness
ALTER TABLE public.budget_submissions
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS parent_submission_id uuid REFERENCES public.budget_submissions(id),
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_late boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS cfo_comment text,
  ADD COLUMN IF NOT EXISTS approved_total numeric NOT NULL DEFAULT 0;
ALTER TABLE public.budget_submissions ALTER COLUMN submitted_by_position_id DROP NOT NULL;
ALTER TABLE public.budget_submissions ALTER COLUMN total_amount SET DEFAULT 0;
ALTER TABLE public.budget_submissions DROP CONSTRAINT IF EXISTS budget_submissions_status_check;
ALTER TABLE public.budget_submissions ADD CONSTRAINT budget_submissions_status_check
  CHECK (status = ANY (ARRAY['draft','submitted','under_review','revision_requested','approved','rejected','superseded','returned','released','paid','cancelled']));
CREATE INDEX IF NOT EXISTS idx_budget_submissions_call_dept ON public.budget_submissions(call_id, department_id);
CREATE INDEX IF NOT EXISTS idx_budget_submissions_status ON public.budget_submissions(status);

-- 3. Lines: Chart-of-Accounts linkage, period, justification, docs, per-line decisions
ALTER TABLE public.budget_submission_lines
  ADD COLUMN IF NOT EXISTS account_code text REFERENCES public.ledger_account_catalog(code),
  ADD COLUMN IF NOT EXISTS period_month date,
  ADD COLUMN IF NOT EXISTS justification text,
  ADD COLUMN IF NOT EXISTS document_path text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_amount numeric,
  ADD COLUMN IF NOT EXISTS decision_note text,
  ADD COLUMN IF NOT EXISTS decided_by uuid,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.budget_submission_lines DROP CONSTRAINT IF EXISTS budget_submission_lines_status_check;
ALTER TABLE public.budget_submission_lines ADD CONSTRAINT budget_submission_lines_status_check
  CHECK (status = ANY (ARRAY['pending','approved','rejected','revision_requested']));
CREATE INDEX IF NOT EXISTS idx_budget_lines_submission ON public.budget_submission_lines(submission_id);
CREATE INDEX IF NOT EXISTS idx_budget_lines_account ON public.budget_submission_lines(account_code);

-- 4. Audit events: allow system actor
ALTER TABLE public.budget_submission_events ALTER COLUMN actor_user_id DROP NOT NULL;

-- 5. Supporting documents
CREATE TABLE IF NOT EXISTS public.budget_submission_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.budget_submissions(id) ON DELETE CASCADE,
  line_id uuid REFERENCES public.budget_submission_lines(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  file_name text,
  uploaded_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.budget_submission_documents TO authenticated;
GRANT ALL ON public.budget_submission_documents TO service_role;
ALTER TABLE public.budget_submission_documents ENABLE ROW LEVEL SECURITY;

-- 6. Helpers
CREATE OR REPLACE FUNCTION public.budget_user_department_ids(_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.department_id
  FROM hr_assignments a
  JOIN hr_staff s ON s.id = a.staff_id
  WHERE s.user_id = _user_id AND a.ended_on IS NULL AND a.department_id IS NOT NULL
  UNION
  SELECT d.id
  FROM staff_profiles sp
  JOIN hr_departments d
    ON lower(d.name) = lower(sp.department) OR lower(d.key) = lower(replace(sp.department,' ','_'))
  WHERE sp.user_id = _user_id AND sp.department IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.is_budget_reviewer(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(_user_id,'cfo') OR public.has_role(_user_id,'ceo')
      OR public.has_role(_user_id,'super_admin') OR public.has_role(_user_id,'manager')
      OR public.has_role(_user_id,'financial_ops');
$$;

CREATE OR REPLACE FUNCTION public.can_access_budget_submission(_submission_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_budget_reviewer(_user_id)
      OR EXISTS (
        SELECT 1 FROM budget_submissions bs
        WHERE bs.id = _submission_id
          AND (bs.submitted_by_user_id = _user_id
               OR bs.department_id IN (SELECT public.budget_user_department_ids(_user_id)))
      );
$$;

-- 7. RLS policies (departments see only their own; reviewers see all)
DROP POLICY IF EXISTS budget_calls_read ON public.budget_calls;
CREATE POLICY budget_calls_read ON public.budget_calls FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS budget_calls_manage ON public.budget_calls;
CREATE POLICY budget_calls_manage ON public.budget_calls FOR ALL TO authenticated
  USING (public.is_budget_reviewer((SELECT auth.uid())))
  WITH CHECK (public.is_budget_reviewer((SELECT auth.uid())));

DROP POLICY IF EXISTS budget_submissions_read ON public.budget_submissions;
CREATE POLICY budget_submissions_read ON public.budget_submissions FOR SELECT TO authenticated
  USING (public.is_budget_reviewer((SELECT auth.uid()))
         OR submitted_by_user_id = (SELECT auth.uid())
         OR department_id IN (SELECT public.budget_user_department_ids((SELECT auth.uid()))));

DROP POLICY IF EXISTS budget_lines_read ON public.budget_submission_lines;
CREATE POLICY budget_lines_read ON public.budget_submission_lines FOR SELECT TO authenticated
  USING (public.can_access_budget_submission(submission_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS budget_events_read ON public.budget_submission_events;
CREATE POLICY budget_events_read ON public.budget_submission_events FOR SELECT TO authenticated
  USING (public.can_access_budget_submission(submission_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS budget_docs_read ON public.budget_submission_documents;
CREATE POLICY budget_docs_read ON public.budget_submission_documents FOR SELECT TO authenticated
  USING (public.can_access_budget_submission(submission_id, (SELECT auth.uid())));
DROP POLICY IF EXISTS budget_docs_write ON public.budget_submission_documents;
CREATE POLICY budget_docs_write ON public.budget_submission_documents FOR INSERT TO authenticated
  WITH CHECK (public.can_access_budget_submission(submission_id, (SELECT auth.uid())));
DROP POLICY IF EXISTS budget_docs_delete ON public.budget_submission_documents;
CREATE POLICY budget_docs_delete ON public.budget_submission_documents FOR DELETE TO authenticated
  USING (uploaded_by = (SELECT auth.uid()) OR public.is_budget_reviewer((SELECT auth.uid())));

DROP POLICY IF EXISTS budget_authorities_read ON public.budget_authorities;
CREATE POLICY budget_authorities_read ON public.budget_authorities FOR SELECT TO authenticated
  USING (public.is_budget_reviewer((SELECT auth.uid())));
DROP POLICY IF EXISTS budget_disbursements_read ON public.budget_disbursements;
CREATE POLICY budget_disbursements_read ON public.budget_disbursements FOR SELECT TO authenticated
  USING (public.is_budget_reviewer((SELECT auth.uid())));

GRANT SELECT ON public.budget_calls, public.budget_submissions, public.budget_submission_lines,
  public.budget_submission_events, public.budget_authorities, public.budget_disbursements TO authenticated;
GRANT ALL ON public.budget_calls, public.budget_submissions, public.budget_submission_lines,
  public.budget_submission_events, public.budget_submission_documents,
  public.budget_authorities, public.budget_disbursements TO service_role;

-- 8. Audit trail triggers (before/after values into existing event mechanism)
CREATE OR REPLACE FUNCTION public.log_budget_submission_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO budget_submission_events(submission_id, event_type, actor_user_id, payload)
    VALUES (NEW.id, 'created', auth.uid(), jsonb_build_object('after', to_jsonb(NEW)));
  ELSIF to_jsonb(OLD) <> to_jsonb(NEW) THEN
    INSERT INTO budget_submission_events(submission_id, event_type, actor_user_id, payload)
    VALUES (NEW.id,
            CASE WHEN OLD.status <> NEW.status THEN 'status_'||NEW.status ELSE 'updated' END,
            auth.uid(),
            jsonb_build_object('before', to_jsonb(OLD), 'after', to_jsonb(NEW)));
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_log_budget_submission_change ON public.budget_submissions;
CREATE TRIGGER trg_log_budget_submission_change
AFTER INSERT OR UPDATE ON public.budget_submissions
FOR EACH ROW EXECUTE FUNCTION public.log_budget_submission_change();

CREATE OR REPLACE FUNCTION public.log_budget_line_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sub uuid;
BEGIN
  v_sub := COALESCE(NEW.submission_id, OLD.submission_id);
  INSERT INTO budget_submission_events(submission_id, event_type, actor_user_id, payload)
  VALUES (v_sub, 'line_'||lower(TG_OP), auth.uid(),
          jsonb_build_object(
            'before', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
            'after',  CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END));
  RETURN COALESCE(NEW, OLD);
END; $$;
DROP TRIGGER IF EXISTS trg_log_budget_line_change ON public.budget_submission_lines;
CREATE TRIGGER trg_log_budget_line_change
AFTER INSERT OR UPDATE OR DELETE ON public.budget_submission_lines
FOR EACH ROW EXECUTE FUNCTION public.log_budget_line_change();

CREATE OR REPLACE FUNCTION public.touch_budget_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_touch_budget_submissions ON public.budget_submissions;
CREATE TRIGGER trg_touch_budget_submissions BEFORE UPDATE ON public.budget_submissions
FOR EACH ROW EXECUTE FUNCTION public.touch_budget_updated_at();
DROP TRIGGER IF EXISTS trg_touch_budget_lines ON public.budget_submission_lines;
CREATE TRIGGER trg_touch_budget_lines BEFORE UPDATE ON public.budget_submission_lines
FOR EACH ROW EXECUTE FUNCTION public.touch_budget_updated_at();

-- 9. Chart-of-Accounts derived Operating/Investing/Financing classification
CREATE OR REPLACE FUNCTION public.budget_activity_for_account(_account_code text)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT m.section FROM cash_flow_line_map m
      WHERE m.account_code = _account_code AND m.section IS NOT NULL LIMIT 1),
    (SELECT CASE
        WHEN c.section IN ('equity','non_current_liability') THEN 'financing'
        WHEN c.section = 'non_current_asset' THEN 'investing'
        ELSE 'operating' END
     FROM ledger_account_catalog c WHERE c.code = _account_code),
    'operating');
$$;