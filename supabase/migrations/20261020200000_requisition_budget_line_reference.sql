-- 2026-10-20: every new requisition references the weekly budget line it spends.
--
-- Decided by the CFO (2026-10-20):
--   * Staff, employee (manual-link) and director requisitions carry a budget_line_id pointing at
--     budget_submission_lines. It is MANDATORY on new requisitions once the CFO switches the rule on.
--     Staff loans (request_kind = 'staff_loan') and growth-commission claims
--     (category = 'growth_commission') are exempt: neither is departmental spend.
--   * A line may be referenced only if
--       - its budget is on the CFO dashboard (past the COO step, exactly as budget_review_queue
--         admits it) and the budget is not rejected, cancelled or superseded, and the line itself
--         was not rejected by the CFO or COO;
--       - its budget call is a weekly ('5days') call whose period covers the requisition date
--         (Africa/Kampala);
--       - it belongs to the requester's own department. Staff requisitions use their department_id,
--         falling back to the requester's HR department(s) when it is empty; when neither exists,
--         and for director and manual-link employee requisitions (no reliable department), the
--         department check is skipped.
--   * A requisition is refused if, with every other live requisition on the same line, it would
--     exceed the line's allowance: its submitted amount (line_total) plus its supplementary budgets
--     (budget_supplements) that have reached the CFO — pending_cfo or approved, at the amount requested,
--     the same "on the CFO dashboard, approved or not" rule as the line itself. Rejected and cancelled
--     requisitions free their amount.
--
-- ROLL-OUT: the mandatory part is OFF until the CFO calls set_requisition_budget_line_required_from()
-- (system_config key requisition_budget_line_required_from). The requisition forms need a budget-line
-- picker first (UI work); switching the rule on before that would block every new requisition.
-- A budget_line_id that IS supplied is validated from the moment this migration runs.
--
-- MONEY SAFETY: nothing here posts to general_ledger, credits or debits a wallet, or changes a
-- requisition's status or approval chain. The budget workflow stays tracking-only (it must never
-- credit a wallet); requisitions are still paid through requisition_wallet_credits as today.
--
-- Rollback: supabase/rollbacks/20261020200000_requisition_budget_line_reference.rollback.sql
-- Verification (rolled back): supabase/tests/requisition_budget_line_reference.sql

-- ─── 0. Safety (B4): fail fast on locks; refuse to run on an unexpected base ──────────────────────
-- ALTER TABLE takes a brief exclusive lock on three live requisition tables. Waiting behind a long
-- query would queue every requisition write behind this migration, so give up after 5 s instead.
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.staff_requisitions') IS NULL OR to_regclass('public.employee_requisitions') IS NULL
     OR to_regclass('public.director_requisitions') IS NULL OR to_regclass('public.budget_submission_lines') IS NULL
     OR to_regclass('public.requisition_wallet_credits') IS NULL OR to_regclass('public.system_config') IS NULL
     OR to_regclass('public.budget_supplements') IS NULL
     OR to_regprocedure('public.is_welile_staff(uuid)') IS NULL OR to_regprocedure('public.staff_requisition_route(uuid)') IS NULL
     OR to_regprocedure('public.budget_user_department_ids(uuid)') IS NULL OR to_regprocedure('public.budget_department_route(uuid)') IS NULL
     OR to_regprocedure('public.is_cfo_approver(uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: a table or function this migration depends on is missing';
  END IF;
END
$pre$;

-- ─── 1. The reference ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.staff_requisitions    ADD COLUMN IF NOT EXISTS budget_line_id uuid REFERENCES public.budget_submission_lines(id);
ALTER TABLE public.employee_requisitions ADD COLUMN IF NOT EXISTS budget_line_id uuid REFERENCES public.budget_submission_lines(id);
ALTER TABLE public.director_requisitions ADD COLUMN IF NOT EXISTS budget_line_id uuid REFERENCES public.budget_submission_lines(id);

CREATE INDEX IF NOT EXISTS staff_requisitions_budget_line_idx    ON public.staff_requisitions (budget_line_id)    WHERE budget_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS employee_requisitions_budget_line_idx ON public.employee_requisitions (budget_line_id) WHERE budget_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS director_requisitions_budget_line_idx ON public.director_requisitions (budget_line_id) WHERE budget_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS budget_supplements_line_idx ON public.budget_supplements (line_id);

-- ─── 2. The switch (off) ─────────────────────────────────────────────────────────────────────────
INSERT INTO public.system_config (key, value, updated_at)
VALUES ('requisition_budget_line_required_from', 'null'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.requisition_budget_line_required_from()
RETURNS timestamptz
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN jsonb_typeof(c.value) = 'string' THEN (c.value #>> '{}')::timestamptz END
    FROM public.system_config c
   WHERE c.key = 'requisition_budget_line_required_from'
$$;

-- ─── 3. Amount already committed to a line (live requisitions, all three tables) ────────────────
CREATE OR REPLACE FUNCTION public.requisition_budget_line_committed(
  p_line_id uuid, p_exclude_table text DEFAULT NULL, p_exclude_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT SUM(COALESCE(s.approved_amount, s.amount)) FROM public.staff_requisitions s
                    WHERE s.budget_line_id = p_line_id
                      AND COALESCE(s.stage, '') NOT IN ('rejected', 'cancelled')
                      AND (p_exclude_id IS NULL OR p_exclude_table IS DISTINCT FROM 'staff_requisitions' OR s.id <> p_exclude_id)), 0)
       + COALESCE((SELECT SUM(COALESCE(e.approved_amount, e.amount)) FROM public.employee_requisitions e
                    WHERE e.budget_line_id = p_line_id
                      AND COALESCE(e.status, '') NOT IN ('rejected', 'cancelled')
                      AND (p_exclude_id IS NULL OR p_exclude_table IS DISTINCT FROM 'employee_requisitions' OR e.id <> p_exclude_id)), 0)
       + COALESCE((SELECT SUM(d.amount) FROM public.director_requisitions d
                    WHERE d.budget_line_id = p_line_id
                      AND COALESCE(d.status, '') NOT IN ('rejected', 'cancelled')
                      AND (p_exclude_id IS NULL OR p_exclude_table IS DISTINCT FROM 'director_requisitions' OR d.id <> p_exclude_id)), 0)
$$;

-- ─── 3b. Supplementary budgets that raise a line's allowance ─────────────────────────────────────
-- One rule for requisition limits AND budget payables (20261020210000 reads this too): a supplement
-- counts once it has reached the CFO (pending_cfo or approved), at the amount requested — like the line
-- itself, approved or not, at the submitted amount. Pending-COO, rejected and cancelled ones do not.
CREATE OR REPLACE FUNCTION public.requisition_budget_line_supplements(p_line_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(sp.amount), 0) FROM public.budget_supplements sp
   WHERE sp.line_id = p_line_id AND sp.status IN ('pending_cfo', 'approved')
$$;

-- ─── 4. The rule, as a side-effect-free check (used by the trigger, the edge functions and the picker)
-- p_department_ids NULL or empty = department check skipped. p_room_only = only the amount check
-- (used when an existing requisition's amount goes up on the same line).
CREATE OR REPLACE FUNCTION public.requisition_budget_line_evaluate(
  p_line_id uuid, p_amount numeric, p_on_date date, p_department_ids uuid[] DEFAULT NULL,
  p_exclude_table text DEFAULT NULL, p_exclude_id uuid DEFAULT NULL, p_room_only boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  l public.budget_submission_lines%ROWTYPE;
  s public.budget_submissions%ROWTYPE;
  c public.budget_calls%ROWTYPE;
  v_committed numeric;
  v_supplements numeric;
  v_room numeric;
BEGIN
  SELECT * INTO l FROM public.budget_submission_lines WHERE id = p_line_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUDGET_LINE_NOT_FOUND',
      'message', 'The selected budget line does not exist.');
  END IF;
  SELECT * INTO s FROM public.budget_submissions WHERE id = l.submission_id;
  SELECT * INTO c FROM public.budget_calls WHERE id = s.call_id;

  IF NOT p_room_only THEN
    IF COALESCE(l.status, '') = 'rejected' OR COALESCE(l.coo_status, '') = 'rejected' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BUDGET_LINE_REJECTED',
        'message', 'This budget line was rejected and cannot be used.');
    END IF;
    IF COALESCE(s.status, '') IN ('draft', 'pending_coo', 'coo_under_review', 'rejected', 'cancelled', 'superseded')
       OR NOT (public.budget_department_route(s.department_id) <> 'coo'
               OR (s.coo_reviewed_at IS NOT NULL
                   AND EXISTS (SELECT 1 FROM public.budget_submission_events e
                                WHERE e.submission_id = s.id AND e.event_type = 'coo_forwarded'))) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BUDGET_NOT_ON_CFO_DASHBOARD',
        'message', 'This budget has not reached the CFO dashboard yet (or was rejected), so its lines cannot be used.');
    END IF;
    IF COALESCE(c.period_type, '') <> '5days' OR p_on_date < c.period_start OR p_on_date > c.period_end THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BUDGET_LINE_WRONG_WEEK',
        'message', format('This budget line belongs to %s (%s to %s), which is not a weekly budget covering %s.',
                          COALESCE(c.title, 'another budget'), c.period_start, c.period_end, p_on_date));
    END IF;
    IF p_department_ids IS NOT NULL AND cardinality(p_department_ids) > 0
       AND NOT (s.department_id = ANY (p_department_ids)) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BUDGET_LINE_OTHER_DEPARTMENT',
        'message', 'This budget line belongs to another department.');
    END IF;
  END IF;

  v_supplements := public.requisition_budget_line_supplements(p_line_id);
  v_committed := public.requisition_budget_line_committed(p_line_id, p_exclude_table, p_exclude_id);
  v_room := COALESCE(l.line_total, 0) + v_supplements - v_committed;
  IF COALESCE(p_amount, 0) > v_room THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUDGET_LINE_OVER_BUDGET',
      'message', format('This would exceed the budget line: UGX %s left of UGX %s.',
                        to_char(greatest(v_room, 0), 'FM999,999,999,990'),
                        to_char(COALESCE(l.line_total, 0) + v_supplements, 'FM999,999,999,990')),
      'remaining', greatest(v_room, 0), 'line_total', l.line_total, 'supplements', v_supplements);
  END IF;

  RETURN jsonb_build_object('ok', true, 'line_total', l.line_total, 'supplements', v_supplements, 'committed', v_committed,
                            'remaining_after', v_room - COALESCE(p_amount, 0),
                            'department_id', s.department_id, 'call_id', s.call_id);
END;
$$;

-- ─── 5. Enforcement on every insert path (edge functions, browser insert, anything later) ───────
CREATE OR REPLACE FUNCTION public.trg_requisition_budget_line_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  o jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  v_line uuid := NULLIF(j->>'budget_line_id', '')::uuid;
  v_old_line uuid := NULLIF(o->>'budget_line_id', '')::uuid;
  v_exempt boolean := false;
  v_active boolean;
  v_old_active boolean;
  v_amount numeric;
  v_old_amount numeric;
  v_on date;
  v_depts uuid[];
  v_required_from timestamptz := public.requisition_budget_line_required_from();
  v_res jsonb;
BEGIN
  IF TG_TABLE_NAME = 'staff_requisitions' THEN
    v_exempt := COALESCE(j->>'request_kind', 'requisition') = 'staff_loan'
             OR COALESCE(j->>'category', '') = 'growth_commission';
    v_active := COALESCE(j->>'stage', '') NOT IN ('rejected', 'cancelled');
    v_old_active := COALESCE(o->>'stage', '') NOT IN ('rejected', 'cancelled');
    v_amount := COALESCE((j->>'approved_amount')::numeric, (j->>'amount')::numeric);
    v_old_amount := COALESCE((o->>'approved_amount')::numeric, (o->>'amount')::numeric);
  ELSIF TG_TABLE_NAME = 'employee_requisitions' THEN
    v_active := COALESCE(j->>'status', '') NOT IN ('rejected', 'cancelled');
    v_old_active := COALESCE(o->>'status', '') NOT IN ('rejected', 'cancelled');
    v_amount := COALESCE((j->>'approved_amount')::numeric, (j->>'amount')::numeric);
    v_old_amount := COALESCE((o->>'approved_amount')::numeric, (o->>'amount')::numeric);
  ELSE -- director_requisitions
    v_active := COALESCE(j->>'status', '') NOT IN ('rejected', 'cancelled');
    v_old_active := COALESCE(o->>'status', '') NOT IN ('rejected', 'cancelled');
    v_amount := (j->>'amount')::numeric;
    v_old_amount := (o->>'amount')::numeric;
  END IF;

  -- B2: once a requisition has been credited to a wallet, its budget line is frozen. Moving or
  -- removing it would re-attribute money already paid to a different budget (or to none).
  IF TG_OP = 'UPDATE' AND v_old_line IS DISTINCT FROM v_line
     AND (COALESCE(o->>'wallet_credit_status', '') IN ('credited', 'reversing')
          OR EXISTS (SELECT 1 FROM public.requisition_wallet_credits w
                      WHERE w.source_table = TG_TABLE_NAME AND w.requisition_id = (o->>'id')::uuid
                        AND w.status IN ('credited', 'reversing'))) THEN
    RAISE EXCEPTION 'BUDGET_LINE_LOCKED: This requisition has already been credited to a wallet, so its budget line can no longer change.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- No line on the row.
  IF v_line IS NULL THEN
    IF NOT v_exempt AND v_active AND v_required_from IS NOT NULL
       AND ((TG_OP = 'INSERT' AND COALESCE((j->>'created_at')::timestamptz, now()) >= v_required_from)
            OR (TG_OP = 'UPDATE' AND v_old_line IS NOT NULL)) THEN
      RAISE EXCEPTION 'BUDGET_LINE_REQUIRED: Choose the weekly budget line this requisition spends.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- A rejected/cancelled requisition never needs checking (it frees its amount).
  IF NOT v_active THEN
    RETURN NEW;
  END IF;

  -- Serialise every requisition against the same line, so two at once cannot overspend it.
  PERFORM 1 FROM public.budget_submission_lines WHERE id = v_line FOR UPDATE;

  IF TG_OP = 'UPDATE' AND v_old_line IS NOT DISTINCT FROM v_line AND v_old_active THEN
    -- Same line, already accepted: only an increase in amount is re-checked, and only for room.
    IF COALESCE(v_amount, 0) <= COALESCE(v_old_amount, 0) THEN
      RETURN NEW;
    END IF;
    v_res := public.requisition_budget_line_evaluate(v_line, v_amount, NULL, NULL, TG_TABLE_NAME, (j->>'id')::uuid, true);
  ELSE
    v_on := (COALESCE((j->>'created_at')::timestamptz, now()) AT TIME ZONE 'Africa/Kampala')::date;
    IF TG_TABLE_NAME = 'staff_requisitions' THEN
      IF NULLIF(j->>'department_id', '') IS NOT NULL THEN
        v_depts := ARRAY[(j->>'department_id')::uuid];
      ELSE
        v_depts := ARRAY(SELECT public.budget_user_department_ids(NULLIF(j->>'requester_id', '')::uuid));
      END IF;
    ELSE
      v_depts := NULL; -- director / manual-link employee: department not verifiable
    END IF;
    v_res := public.requisition_budget_line_evaluate(v_line, v_amount, v_on, v_depts, TG_TABLE_NAME, (j->>'id')::uuid, false);
  END IF;

  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RAISE EXCEPTION '%: %', v_res->>'code', v_res->>'message' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_requisition_budget_line_guard ON public.staff_requisitions;
CREATE TRIGGER trg_requisition_budget_line_guard
  BEFORE INSERT OR UPDATE ON public.staff_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.trg_requisition_budget_line_guard();
DROP TRIGGER IF EXISTS trg_requisition_budget_line_guard ON public.employee_requisitions;
CREATE TRIGGER trg_requisition_budget_line_guard
  BEFORE INSERT OR UPDATE ON public.employee_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.trg_requisition_budget_line_guard();
DROP TRIGGER IF EXISTS trg_requisition_budget_line_guard ON public.director_requisitions;
CREATE TRIGGER trg_requisition_budget_line_guard
  BEFORE INSERT OR UPDATE ON public.director_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.trg_requisition_budget_line_guard();

-- ─── 5b. A line that requisitions reference cannot be removed ────────────────────────────────────
-- A budget the CFO returns ('returned') can be edited again: budget_remove_line deletes lines, and
-- budget_save_draft replaces all lines of a draft. Removing a line that requisitions reference would
-- orphan money already committed or paid against it, so the foreign key refuses; this trigger turns
-- that refusal into a plain message. Lines nobody references can still be removed as today.
-- (Rejected or cancelled requisitions keep their reference too, as history.)
CREATE OR REPLACE FUNCTION public.trg_budget_line_in_use_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_n bigint;
BEGIN
  SELECT (SELECT count(*) FROM public.staff_requisitions    WHERE budget_line_id = OLD.id)
       + (SELECT count(*) FROM public.employee_requisitions WHERE budget_line_id = OLD.id)
       + (SELECT count(*) FROM public.director_requisitions WHERE budget_line_id = OLD.id)
    INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'This budget line cannot be removed: % requisition(s) already reference it. Keep the line, and add a new line for any change.', v_n
      USING ERRCODE = 'foreign_key_violation', DETAIL = 'BUDGET_LINE_IN_USE';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_budget_line_in_use_guard ON public.budget_submission_lines;
CREATE TRIGGER trg_budget_line_in_use_guard
  BEFORE DELETE ON public.budget_submission_lines
  FOR EACH ROW EXECUTE FUNCTION public.trg_budget_line_in_use_guard();

-- ─── 6. Lines a signed-in person may pick now (for the requisition forms) ────────────────────────
-- B5: only people who may raise requisitions can call it (the same rule as staff-requisition-submit:
-- Welile staff, or agents with an active Agents' Space grant), and only for departments they may file
-- under: their HR department(s), the department staff_requisition_route gives them, and Agent Ops for
-- Agents' Space agents without an HR department. p_department_id must be one of those.
-- Staff with no department at all (e.g. directors) see every valid line — the department check is
-- skipped for them, exactly as the trigger does.
CREATE OR REPLACE FUNCTION public.requisition_budget_lines_available(p_department_id uuid DEFAULT NULL)
RETURNS TABLE (
  line_id uuid, department_id uuid, department_name text, call_id uuid, call_title text,
  period_start date, period_end date, description text, category text, account_code text,
  line_total numeric, supplements numeric, allowance numeric, committed numeric, remaining numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_is_staff boolean;
  v_space_agent boolean;
  v_allowed uuid[];
  v_depts uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_is_staff := COALESCE(public.is_welile_staff(v_uid), false);
  v_space_agent := EXISTS (SELECT 1 FROM public.staff_permissions sp
                            WHERE sp.user_id = v_uid AND sp.permitted_dashboard = 'agents-space' AND sp.revoked_at IS NULL);
  IF NOT v_is_staff AND NOT v_space_agent THEN
    RAISE EXCEPTION 'Only people who may raise requisitions can list budget lines' USING ERRCODE = '42501';
  END IF;

  v_allowed := ARRAY(
    SELECT x FROM (
      SELECT public.budget_user_department_ids(v_uid) AS x
      UNION SELECT r.department_id FROM public.staff_requisition_route(v_uid) r WHERE r.department_id IS NOT NULL
      UNION SELECT h.id FROM public.hr_departments h
             WHERE NOT v_is_staff AND v_space_agent AND h.key = 'agent_ops' AND COALESCE(h.active, true)
    ) a WHERE x IS NOT NULL);

  IF p_department_id IS NOT NULL THEN
    IF NOT (p_department_id = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'You can only list budget lines for your own department' USING ERRCODE = '42501';
    END IF;
    v_depts := ARRAY[p_department_id];
  ELSIF cardinality(v_allowed) > 0 THEN
    v_depts := v_allowed;
  ELSE
    v_depts := NULL;   -- staff with no department: department check skipped (as in the trigger)
  END IF;
  RETURN QUERY
    SELECT l.id, s.department_id, d.name, c.id, c.title, c.period_start, c.period_end,
           l.description, l.category, l.account_code, l.line_total,
           x.supplements, COALESCE(l.line_total, 0) + x.supplements, x.committed,
           greatest(COALESCE(l.line_total, 0) + x.supplements - x.committed, 0)
      FROM public.budget_submission_lines l
      JOIN public.budget_submissions s ON s.id = l.submission_id
      JOIN public.budget_calls c ON c.id = s.call_id
      LEFT JOIN public.hr_departments d ON d.id = s.department_id
      CROSS JOIN LATERAL (SELECT public.requisition_budget_line_supplements(l.id) AS supplements,
                                 public.requisition_budget_line_committed(l.id) AS committed) x
     WHERE c.period_type = '5days' AND v_today BETWEEN c.period_start AND c.period_end
       AND COALESCE((public.requisition_budget_line_evaluate(l.id, 0, v_today, v_depts)->>'ok')::boolean, false)
     ORDER BY c.period_start DESC, d.name, l.sort_order;
END;
$$;

-- ─── 7. The CFO's switch ─────────────────────────────────────────────────────────────────────────
-- p_from NULL switches the mandatory rule off; a timestamp makes it apply to requisitions created
-- from that moment.
CREATE OR REPLACE FUNCTION public.set_requisition_budget_line_required_from(p_from timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'Only the CFO can change the requisition budget-line rule' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.system_config (key, value, updated_at)
  VALUES ('requisition_budget_line_required_from',
          CASE WHEN p_from IS NULL THEN 'null'::jsonb ELSE to_jsonb(p_from) END, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  INSERT INTO public.audit_logs (user_id, action_type, table_name, metadata)
  VALUES (v_uid, 'requisition_budget_line_rule_set', 'system_config',
          jsonb_build_object('key', 'requisition_budget_line_required_from', 'required_from', p_from));
  RETURN jsonb_build_object('ok', true, 'required_from', p_from);
END;
$$;

-- ─── 8. Grants ───────────────────────────────────────────────────────────────────────────────────
-- Default privileges hand every new function to anon and authenticated; take that back.
REVOKE ALL ON FUNCTION public.requisition_budget_line_required_from() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requisition_budget_line_committed(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requisition_budget_line_supplements(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requisition_budget_line_evaluate(uuid, numeric, date, uuid[], text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_requisition_budget_line_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_budget_line_in_use_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requisition_budget_lines_available(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_requisition_budget_line_required_from(timestamptz) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.requisition_budget_line_required_from() TO service_role;
GRANT EXECUTE ON FUNCTION public.requisition_budget_line_committed(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.requisition_budget_line_supplements(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.requisition_budget_line_evaluate(uuid, numeric, date, uuid[], text, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.requisition_budget_lines_available(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_requisition_budget_line_required_from(timestamptz) TO authenticated, service_role;

RESET lock_timeout;
