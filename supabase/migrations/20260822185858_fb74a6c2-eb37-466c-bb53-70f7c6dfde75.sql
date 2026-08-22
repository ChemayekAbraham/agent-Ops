-- ─────────────────────────────────────────────────────────────────────────────
-- Staff requisitions: My Space -> department head -> COO -> CFO -> wallet
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS public.staff_requisition_seq START 1;

CREATE TABLE public.staff_requisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_code text NOT NULL UNIQUE
    DEFAULT ('SRQ-' || lpad(nextval('public.staff_requisition_seq')::text, 5, '0')),
  requester_id uuid NOT NULL,
  requester_name text,
  requester_role text,
  department_id uuid REFERENCES public.hr_departments(id),
  department_key text,
  title text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'UGX',
  category text,
  reason text NOT NULL,
  needed_by date,
  attachment_urls text[] NOT NULL DEFAULT '{}',
  stage text NOT NULL DEFAULT 'supervisor'
    CHECK (stage IN ('supervisor','coo','cfo','ceo','approved','rejected','returned')),
  current_approver_role text,
  final_stage text NOT NULL DEFAULT 'cfo' CHECK (final_stage IN ('cfo','ceo')),
  returned_from_stage text,
  supervisor_decided_by uuid,
  supervisor_decided_at timestamptz,
  supervisor_note text,
  coo_decided_by uuid,
  coo_decided_at timestamptz,
  coo_note text,
  cfo_decided_by uuid,
  cfo_decided_at timestamptz,
  cfo_note text,
  approved_amount numeric,
  rejection_reason text,
  decided_at timestamptz,
  wallet_credit_status text,
  wallet_transaction_id text,
  credited_at timestamptz,
  credited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.staff_requisitions TO authenticated;
GRANT ALL ON public.staff_requisitions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.staff_requisition_seq TO service_role;

ALTER TABLE public.staff_requisitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view all staff requisitions"
  ON public.staff_requisitions FOR SELECT TO authenticated
  USING (public.is_welile_staff(auth.uid()));

CREATE POLICY "Requesters can view their own staff requisitions"
  ON public.staff_requisitions FOR SELECT TO authenticated
  USING (requester_id = auth.uid());

CREATE TRIGGER trg_staff_requisitions_updated_at
  BEFORE UPDATE ON public.staff_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_staff_requisitions_stage ON public.staff_requisitions(stage, current_approver_role);
CREATE INDEX idx_staff_requisitions_requester ON public.staff_requisitions(requester_id, created_at DESC);
CREATE INDEX idx_staff_requisitions_department ON public.staff_requisitions(department_id, created_at DESC);

-- Append-only audit trail
CREATE TABLE public.staff_requisition_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL REFERENCES public.staff_requisitions(id) ON DELETE CASCADE,
  actor_id uuid,
  actor_name text,
  actor_role text,
  action text NOT NULL CHECK (action IN ('created','approved','rejected','returned','resubmitted','credited','credit_failed','comment')),
  stage text,
  comment text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.staff_requisition_events TO authenticated;
GRANT ALL ON public.staff_requisition_events TO service_role;

ALTER TABLE public.staff_requisition_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view staff requisition events"
  ON public.staff_requisition_events FOR SELECT TO authenticated
  USING (
    public.is_welile_staff(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.staff_requisitions r
       WHERE r.id = staff_requisition_events.requisition_id
         AND r.requester_id = auth.uid()
    )
  );

CREATE INDEX idx_staff_requisition_events_req
  ON public.staff_requisition_events(requisition_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Department -> first approver routing (data driven, never hard coded)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.staff_requisition_department_routes (
  department_id uuid PRIMARY KEY REFERENCES public.hr_departments(id) ON DELETE CASCADE,
  approver_role text NOT NULL,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.staff_requisition_department_routes TO authenticated;
GRANT ALL ON public.staff_requisition_department_routes TO service_role;

ALTER TABLE public.staff_requisition_department_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view requisition routes"
  ON public.staff_requisition_department_routes FOR SELECT TO authenticated
  USING (public.is_welile_staff(auth.uid()));

CREATE TRIGGER trg_staff_req_routes_updated_at
  BEFORE UPDATE ON public.staff_requisition_department_routes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.staff_requisition_department_routes (department_id, approver_role)
SELECT d.id,
       CASE d.key
         WHEN 'engineering' THEN 'cto'
         WHEN 'product_research_and_development' THEN 'cto'
         WHEN 'marketing' THEN 'cmo'
         WHEN 'finance' THEN 'cfo'
         WHEN 'operations' THEN 'coo'
         WHEN 'tenant_ops' THEN 'tenant_ops'
         WHEN 'agent_ops' THEN 'agent_ops'
         WHEN 'landlord_ops' THEN 'landlord_ops'
         WHEN 'partner_ops' THEN 'partner_ops'
         WHEN 'partnership' THEN 'crm'
         WHEN 'customer_care' THEN 'crm'
         WHEN 'interns' THEN 'hr'
         WHEN 'support_and_welfare' THEN 'hr'
         WHEN 'board_of_directors' THEN 'ceo'
         ELSE 'coo'
       END
  FROM public.hr_departments d
ON CONFLICT (department_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Routing resolver: department + first stage + final stage for a requester
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_requisition_route(_user_id uuid)
RETURNS TABLE (
  department_id uuid,
  department_key text,
  department_name text,
  stage text,
  approver_role text,
  final_stage text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dept_id uuid;
  v_key text;
  v_name text;
  v_route text;
  v_roles text[];
  v_stage text;
  v_final text := 'cfo';
BEGIN
  SELECT d.id, d.key, d.name
    INTO v_dept_id, v_key, v_name
    FROM hr_departments d
    JOIN hr_assignments a ON a.department_id = d.id
    JOIN hr_staff s ON s.id = a.staff_id
   WHERE d.active
     AND s.user_id = _user_id
     AND (a.ended_on IS NULL OR a.ended_on >= CURRENT_DATE)
   ORDER BY a.is_primary DESC NULLS LAST, a.started_on DESC NULLS LAST
   LIMIT 1;

  IF v_dept_id IS NULL THEN
    SELECT d.id, d.key, d.name
      INTO v_dept_id, v_key, v_name
      FROM hr_departments d
      JOIN operations_departments od ON lower(od.department) = lower(d.key)
     WHERE d.active AND od.user_id = _user_id
     LIMIT 1;
  END IF;

  IF v_dept_id IS NULL THEN
    RETURN;  -- no department: caller must reject the submission
  END IF;

  SELECT r.approver_role INTO v_route
    FROM staff_requisition_department_routes r
   WHERE r.department_id = v_dept_id;
  v_route := COALESCE(v_route, 'coo');

  SELECT COALESCE(array_agg(ur.role::text), '{}')
    INTO v_roles
    FROM user_roles ur
   WHERE ur.user_id = _user_id AND ur.enabled = true;

  -- Nobody reviews their own money.
  IF 'coo' = ANY(v_roles) THEN
    v_stage := 'cfo';
    v_route := 'cfo';
  ELSIF 'cfo' = ANY(v_roles) THEN
    v_stage := 'coo';
    v_route := 'coo';
    v_final := 'ceo';
  ELSIF v_route = ANY(v_roles) OR v_route = 'coo' THEN
    v_stage := 'coo';
    v_route := 'coo';
  ELSE
    v_stage := 'supervisor';
  END IF;

  RETURN QUERY SELECT v_dept_id, v_key, v_name, v_stage, v_route, v_final;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Budget context (warning only, never a hard block)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_staff_requisition_budget_context
WITH (security_invoker = true)
AS
WITH cycle AS (
  SELECT c.id, c.period_start, c.period_end
    FROM budget_calls c
   WHERE c.status = 'open'
   ORDER BY c.period_start DESC
   LIMIT 1
),
budget AS (
  SELECT s.department_id,
         SUM(COALESCE(l.approved_amount, l.coo_approved_amount, l.line_total, 0)) AS approved_budget
    FROM budget_submissions s
    JOIN budget_submission_lines l ON l.submission_id = s.id
    LEFT JOIN cycle cy ON true
   WHERE (cy.id IS NULL OR s.call_id = cy.id)
   GROUP BY s.department_id
),
committed AS (
  SELECT r.department_id,
         SUM(COALESCE(r.approved_amount, r.amount)) FILTER (WHERE r.stage <> 'rejected') AS committed_amount,
         SUM(COALESCE(r.approved_amount, r.amount)) FILTER (WHERE r.stage = 'approved') AS approved_amount
    FROM staff_requisitions r
    LEFT JOIN cycle cy ON true
   WHERE (cy.id IS NULL OR r.created_at::date BETWEEN cy.period_start AND cy.period_end)
   GROUP BY r.department_id
)
SELECT d.id AS department_id,
       d.key AS department_key,
       d.name AS department_name,
       COALESCE(b.approved_budget, 0) AS approved_budget,
       COALESCE(c.committed_amount, 0) AS committed_amount,
       COALESCE(c.approved_amount, 0) AS credited_amount,
       COALESCE(b.approved_budget, 0) - COALESCE(c.committed_amount, 0) AS remaining_budget
  FROM hr_departments d
  LEFT JOIN budget b ON b.department_id = d.id
  LEFT JOIN committed c ON c.department_id = d.id
 WHERE d.active;

GRANT SELECT ON public.v_staff_requisition_budget_context TO authenticated;
GRANT SELECT ON public.v_staff_requisition_budget_context TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Legacy flows become read-only history (no new submissions)
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE INSERT ON public.director_requisitions FROM authenticated, anon;
REVOKE INSERT ON public.employee_requisitions FROM authenticated, anon;