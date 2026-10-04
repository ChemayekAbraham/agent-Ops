-- 1. Configurable per-department approval route (optional override)
CREATE TABLE public.budget_department_routes (
  department_id uuid PRIMARY KEY REFERENCES public.hr_departments(id) ON DELETE CASCADE,
  route text NOT NULL CHECK (route IN ('coo','direct')),
  reason text,
  changed_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.budget_department_routes TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.budget_department_routes TO authenticated;
GRANT ALL ON public.budget_department_routes TO service_role;

ALTER TABLE public.budget_department_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view budget routes"
  ON public.budget_department_routes FOR SELECT TO authenticated USING (true);

CREATE POLICY "Budget reviewers manage routes"
  ON public.budget_department_routes FOR ALL TO authenticated
  USING (public.is_budget_reviewer(auth.uid()) OR public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.is_budget_reviewer(auth.uid()) OR public.has_role(auth.uid(), 'super_admin'));

CREATE TRIGGER trg_budget_department_routes_touch
  BEFORE UPDATE ON public.budget_department_routes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Route resolution: configured override first, then the four ops departments, else direct
CREATE OR REPLACE FUNCTION public.budget_department_route(_department_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT r.route FROM budget_department_routes r WHERE r.department_id = _department_id),
    (SELECT CASE WHEN lower(d.key) IN ('tenant_ops','agent_ops','landlord_ops','partner_ops')
                 THEN 'coo' ELSE 'direct' END
       FROM hr_departments d WHERE d.id = _department_id),
    'direct'
  );
$$;

-- 3. Department membership comes strictly from active HR assignments to active departments
CREATE OR REPLACE FUNCTION public.budget_user_department_ids(_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT a.department_id
  FROM hr_assignments a
  JOIN hr_staff s ON s.id = a.staff_id
  JOIN hr_departments d ON d.id = a.department_id AND d.active
  WHERE s.user_id = _user_id
    AND a.ended_on IS NULL
    AND a.department_id IS NOT NULL;
$$;

-- 4. Submissions must always name an existing, active HR department
ALTER TABLE public.budget_submissions ALTER COLUMN department_id SET NOT NULL;

CREATE OR REPLACE FUNCTION public.budget_save_draft(
  p_submission_id uuid,
  p_call_id uuid,
  p_department_id uuid,
  p_title text,
  p_purpose text,
  p_lines jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := p_submission_id;
  v_call budget_calls;
  v_status text;
  v_total numeric := 0;
  v_line jsonb;
  v_idx int := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  IF v_id IS NULL THEN
    IF p_department_id IS NULL THEN
      RAISE EXCEPTION 'A registered HR department is required for a budget';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM hr_departments d WHERE d.id = p_department_id AND d.active) THEN
      RAISE EXCEPTION 'Department is not an active registered HR department';
    END IF;
    SELECT * INTO v_call FROM budget_calls WHERE id = p_call_id;
    IF v_call.id IS NULL THEN RAISE EXCEPTION 'Budget cycle not found'; END IF;
    IF v_call.status <> 'open' THEN RAISE EXCEPTION 'Budget cycle is not open'; END IF;
    IF NOT (public.is_budget_reviewer(v_uid)
            OR p_department_id IN (SELECT public.budget_user_department_ids(v_uid))) THEN
      RAISE EXCEPTION 'You can only budget for a department you are assigned to in HR';
    END IF;
    INSERT INTO budget_submissions(call_id, department_id, reference, title, purpose, status,
                                   period_type, period_start, period_end, submitted_by_user_id, total_amount)
    VALUES (p_call_id, p_department_id,
            'BGT-'||to_char(now(),'YYMMDD')||'-'||upper(substr(md5(random()::text),1,6)),
            p_title, p_purpose, 'draft',
            v_call.period_type, v_call.period_start, v_call.period_end, v_uid, 0)
    RETURNING id INTO v_id;
  ELSE
    SELECT status INTO v_status FROM budget_submissions WHERE id = v_id;
    IF v_status IS NULL THEN RAISE EXCEPTION 'Submission not found'; END IF;
    IF NOT public.can_access_budget_submission(v_id, v_uid) THEN RAISE EXCEPTION 'Not authorised'; END IF;
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'Submission is read-only in status %', v_status; END IF;
    IF NOT EXISTS (SELECT 1 FROM budget_calls bc JOIN budget_submissions bs ON bs.call_id = bc.id
                    WHERE bs.id = v_id AND bc.status = 'open') THEN
      RAISE EXCEPTION 'Budget cycle is not open';
    END IF;
    UPDATE budget_submissions SET title = p_title, purpose = p_purpose WHERE id = v_id;
  END IF;

  IF p_lines IS NOT NULL THEN
    DELETE FROM budget_submission_lines WHERE submission_id = v_id;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      v_idx := v_idx + 1;
      IF COALESCE(NULLIF(v_line->>'description',''), '') = '' THEN
        RAISE EXCEPTION 'Line % is missing a description', v_idx;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM ledger_account_catalog WHERE code = v_line->>'account_code') THEN
        RAISE EXCEPTION 'Line % has an invalid budget category (Chart of Accounts code)', v_idx;
      END IF;
      IF NOT public.budget_is_budgetable_account(v_line->>'account_code') THEN
        RAISE EXCEPTION 'Line % uses category % which is not a budgetable spending category', v_idx, v_line->>'account_code';
      END IF;
      INSERT INTO budget_submission_lines(submission_id, sort_order, description, category, account_code,
        quantity, unit_amount, period_month, justification, document_path, status)
      VALUES (v_id, v_idx, v_line->>'description',
              NULLIF(v_line->>'category',''), v_line->>'account_code',
              GREATEST(COALESCE((v_line->>'quantity')::numeric, 1), 0.0001),
              GREATEST(COALESCE((v_line->>'unit_amount')::numeric, 0), 0),
              NULLIF(v_line->>'period_month','')::date,
              NULLIF(v_line->>'justification',''),
              NULLIF(v_line->>'document_path',''), 'pending');
    END LOOP;
  END IF;

  SELECT COALESCE(SUM(line_total),0) INTO v_total FROM budget_submission_lines WHERE submission_id = v_id;
  UPDATE budget_submissions SET total_amount = v_total WHERE id = v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.budget_save_draft(uuid, uuid, uuid, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.budget_department_route(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.budget_user_department_ids(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.budget_save_draft(uuid, uuid, uuid, text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.budget_department_route(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.budget_user_department_ids(uuid) TO authenticated, service_role;