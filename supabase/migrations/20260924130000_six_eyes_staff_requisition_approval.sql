-- Six-eyes staff requisition approval (handover doc 120).
--
-- Every ordinary staff requisition (request_kind = 'requisition') now needs
-- three different people to approve it, in order: COO -> CEO -> CFO. A
-- department-head (supervisor) stage, where a department has one, still comes
-- first and is an extra pair of eyes.
--
-- Before this, "nobody reviews their own money" was done by skipping stages:
-- a COO's own requisition started at the CFO (one approver), a CFO's own went
-- COO -> CEO, growth-commission claims went CEO -> CFO, and the decide
-- function let any super_admin / manager / CEO approve at any stage. The rule
-- is now enforced per person, not per role, because three people hold
-- CEO + CFO + COO at once.
--
-- Staff loans and PSO facilitation keep their own chains
-- (staff_loan_chain_guard / pso_facilitation_guard) and are untouched.

-- ── 1. Event actions ────────────────────────────────────────────────────────
-- 'amount_reduced' was already written by staff_requisition_reduce_amount()
-- but missing from the check, so that RPC could never succeed.
ALTER TABLE public.staff_requisition_events
  DROP CONSTRAINT IF EXISTS staff_requisition_events_action_check;
ALTER TABLE public.staff_requisition_events
  ADD CONSTRAINT staff_requisition_events_action_check CHECK (action = ANY (ARRAY[
    'created', 'approved', 'rejected', 'returned', 'resubmitted',
    'credited', 'credit_failed', 'comment', 'amount_reduced', 'rerouted'
  ]));

-- ── 2. Routing: never skip a stage ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_requisition_route(_user_id uuid)
 RETURNS TABLE(department_id uuid, department_key text, department_name text, stage text, approver_role text, final_stage text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dept_id uuid;
  v_key text;
  v_name text;
  v_route text;
  v_roles text[];
  v_stage text;
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
    RETURN;  -- no department: caller routes to the COO
  END IF;

  SELECT r.approver_role INTO v_route
    FROM staff_requisition_department_routes r
   WHERE r.department_id = v_dept_id;
  v_route := COALESCE(v_route, 'coo');

  SELECT COALESCE(array_agg(ur.role::text), '{}')
    INTO v_roles
    FROM user_roles ur
   WHERE ur.user_id = _user_id AND ur.enabled = true;

  -- Six eyes: every requisition runs COO -> CEO -> CFO. A requester who holds
  -- one of those roles is NOT skipped past it; another holder of that role
  -- must sign (enforced per person by staff_requisition_six_eyes_guard).
  -- Only the department-head stage is skipped when the requester is the head.
  IF v_route = ANY(v_roles) OR v_route IN ('coo', 'ceo', 'cfo') THEN
    v_stage := 'coo';
    v_route := 'coo';
  ELSE
    v_stage := 'supervisor';
  END IF;

  RETURN QUERY SELECT v_dept_id, v_key, v_name, v_stage, v_route, 'cfo'::text;
END;
$function$;

-- ── 3. Re-route requisitions already in flight ──────────────────────────────
-- Done before the guard exists, since these are backwards moves the guard
-- refuses. Any row at CEO/CFO missing an earlier sign-off goes back to the
-- first missing stage. (SRQ-00148 and SRQ-00145, the two rows this was written
-- for, were credited under the old routing on 2026-09-24 06:44 UTC before it
-- landed — see doc 120. When written, nothing else was in flight at CEO/CFO.)
WITH moved AS (
  UPDATE public.staff_requisitions r
     SET stage = CASE WHEN r.coo_decided_by IS NULL OR r.coo_decided_by = r.requester_id
                      THEN 'coo' ELSE 'ceo' END,
         current_approver_role = CASE WHEN r.coo_decided_by IS NULL OR r.coo_decided_by = r.requester_id
                                      THEN 'coo' ELSE 'ceo' END,
         final_stage = 'cfo'
   WHERE COALESCE(r.request_kind, 'requisition') = 'requisition'
     AND r.stage IN ('ceo', 'cfo')
     AND (r.coo_decided_by IS NULL OR r.coo_decided_by = r.requester_id
          OR (r.stage = 'cfo' AND r.ceo_decided_by IS NULL)
          OR r.final_stage IS DISTINCT FROM 'cfo')
  RETURNING r.id, r.stage
)
INSERT INTO public.staff_requisition_events (requisition_id, actor_id, actor_name, action, stage, comment, metadata)
SELECT m.id, NULL, 'System', 'rerouted', m.stage,
       'Re-routed under six-eyes approval: every requisition needs COO, CEO and CFO sign-off from three different people.',
       jsonb_build_object('reason', 'six_eyes_2026_09_24')
  FROM moved m;

UPDATE public.staff_requisitions
   SET final_stage = 'cfo'
 WHERE COALESCE(request_kind, 'requisition') = 'requisition'
   AND stage IN ('supervisor', 'coo', 'returned')
   AND final_stage IS DISTINCT FROM 'cfo';

-- ── 4. The guard ────────────────────────────────────────────────────────────
-- Structural guarantee independent of edge-function code: a requisition can
-- only reach 'approved' with coo_decided_by, ceo_decided_by and cfo_decided_by
-- all set, all different people, none of them the requester (nor the
-- department head who signed first), each holding the role they signed as.
CREATE OR REPLACE FUNCTION public.staff_requisition_assert_signer(
  p_signer uuid, p_role text, p_requester uuid, p_prior uuid[]
) RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_signer IS NULL THEN
    RAISE EXCEPTION 'Six-eyes approval: the % sign-off is missing.', upper(p_role);
  END IF;
  IF p_signer = p_requester THEN
    RAISE EXCEPTION 'Six-eyes approval: the requester cannot sign their own requisition.';
  END IF;
  IF p_signer = ANY (array_remove(p_prior, NULL)) THEN
    RAISE EXCEPTION 'Six-eyes approval: the % sign-off must come from a different person than the earlier approvers.', upper(p_role);
  END IF;
  IF NOT public.has_role(p_signer, p_role::app_role) THEN
    RAISE EXCEPTION 'Six-eyes approval: the % sign-off came from someone who does not hold the % role.', upper(p_role), upper(p_role);
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_requisition_assert_signer(uuid, text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.staff_requisition_six_eyes_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_open constant text[] := ARRAY['supervisor', 'coo', 'ceo', 'cfo'];
BEGIN
  IF COALESCE(NEW.request_kind, 'requisition') <> 'requisition' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Every requisition enters at the department head or the COO and ends at
    -- the CFO, whoever raised it and whatever the caller asked for.
    IF NEW.stage IS DISTINCT FROM 'supervisor' THEN
      NEW.stage := 'coo';
      NEW.current_approver_role := 'coo';
    END IF;
    NEW.final_stage := 'cfo';
    NEW.supervisor_decided_by := NULL; NEW.supervisor_decided_at := NULL;
    NEW.hr_decided_by := NULL;         NEW.hr_decided_at := NULL;
    NEW.coo_decided_by := NULL;        NEW.coo_decided_at := NULL;
    NEW.ceo_decided_by := NULL;        NEW.ceo_decided_at := NULL;
    NEW.cfo_decided_by := NULL;        NEW.cfo_decided_at := NULL;
    NEW.approved_amount := NULL;
    NEW.wallet_credit_status := NULL;
    NEW.decided_at := NULL;
    RETURN NEW;
  END IF;

  -- An approver may lower the amount but never raise it: a later signer
  -- cannot approve more than the earlier signers saw.
  IF OLD.stage = ANY (v_open)
     AND NEW.approved_amount IS NOT NULL
     AND NEW.approved_amount > COALESCE(OLD.approved_amount, OLD.amount) THEN
    RAISE EXCEPTION 'Six-eyes approval: an approver cannot raise the amount above what earlier approvers saw (%).',
      COALESCE(OLD.approved_amount, OLD.amount);
  END IF;

  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;

  -- Stopping money needs no quorum: decline / send back from any open stage.
  IF OLD.stage = ANY (v_open) AND NEW.stage IN ('rejected', 'returned') THEN
    RETURN NEW;
  END IF;

  IF OLD.stage = 'supervisor' AND NEW.stage = 'coo' THEN
    IF NEW.supervisor_decided_by IS NULL OR NEW.supervisor_decided_by = NEW.requester_id THEN
      RAISE EXCEPTION 'Six-eyes approval: the department sign-off is missing or is the requester.';
    END IF;

  ELSIF OLD.stage = 'coo' AND NEW.stage = 'ceo' THEN
    PERFORM public.staff_requisition_assert_signer(NEW.coo_decided_by, 'coo', NEW.requester_id,
      ARRAY[NEW.supervisor_decided_by]);

  ELSIF OLD.stage = 'ceo' AND NEW.stage = 'cfo' THEN
    PERFORM public.staff_requisition_assert_signer(NEW.ceo_decided_by, 'ceo', NEW.requester_id,
      ARRAY[NEW.supervisor_decided_by, NEW.coo_decided_by]);

  ELSIF OLD.stage = 'cfo' AND NEW.stage = 'approved' THEN
    PERFORM public.staff_requisition_assert_signer(NEW.coo_decided_by, 'coo', NEW.requester_id,
      ARRAY[NEW.supervisor_decided_by]);
    PERFORM public.staff_requisition_assert_signer(NEW.ceo_decided_by, 'ceo', NEW.requester_id,
      ARRAY[NEW.supervisor_decided_by, NEW.coo_decided_by]);
    PERFORM public.staff_requisition_assert_signer(NEW.cfo_decided_by, 'cfo', NEW.requester_id,
      ARRAY[NEW.supervisor_decided_by, NEW.coo_decided_by, NEW.ceo_decided_by]);

  ELSIF OLD.stage = 'approved' AND NEW.stage = 'cfo'
        AND NEW.wallet_credit_status = 'failed'
        AND COALESCE(OLD.wallet_credit_status, '') <> 'credited' THEN
    NULL;  -- staff-requisition-decide rolling back a failed wallet credit

  ELSIF OLD.stage = 'returned' AND NEW.stage = ANY (v_open) THEN
    -- A resubmission that raises the amount starts the chain again.
    IF NEW.amount > OLD.amount
       AND (NEW.coo_decided_by IS NOT NULL OR NEW.ceo_decided_by IS NOT NULL OR NEW.cfo_decided_by IS NOT NULL) THEN
      RAISE EXCEPTION 'Six-eyes approval: a resubmission that raises the amount must restart approval from the beginning.';
    END IF;
    IF NEW.stage NOT IN ('supervisor', 'coo') AND NEW.stage IS DISTINCT FROM OLD.returned_from_stage THEN
      RAISE EXCEPTION 'Six-eyes approval: a resubmission can only return to the stage that sent it back (%).',
        OLD.returned_from_stage;
    END IF;

  ELSE
    RAISE EXCEPTION 'Six-eyes approval: illegal requisition stage change % -> %.', OLD.stage, NEW.stage;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS staff_requisition_six_eyes_guard_trg ON public.staff_requisitions;
CREATE TRIGGER staff_requisition_six_eyes_guard_trg
  BEFORE INSERT OR UPDATE ON public.staff_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.staff_requisition_six_eyes_guard();
