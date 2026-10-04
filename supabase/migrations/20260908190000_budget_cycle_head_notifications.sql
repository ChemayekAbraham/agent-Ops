-- Budget cycle-open notifications: route to designated departmental heads only.
--
-- WHAT WAS WRONG
-- budget_notify_cycle_open() wrote ONE row per department into
-- budget_department_notifications and nothing per user. "Recipients" were
-- therefore resolved at READ time by budget_can_access_department(), which is
-- true for anyone in operations_departments for that department OR anyone whose
-- staff_permissions.permitted_dashboard maps to it. Live effect: a single
-- Tenant Ops cycle notice was visible to 17 people, Agent Ops 14, Landlord Ops
-- 10, Partner Ops 7. There was no concept of a department head anywhere:
-- hr_departments has columns (id, key, name, measurement_mode, active,
-- created_at) and no head column. The legacy `departments` table does have
-- head_user_id but holds one row and is unused by this flow.
--
-- WHAT THIS CHANGES
--   1. Adds budget_department_heads — the data-driven mapping that did not exist.
--   2. budget_notify_cycle_open() additionally delivers a PERSONAL notice to each
--      designated head of each TARGETED department.
--   3. get_budget_department_notifications() and the table's RLS policy are
--      head-gated, so non-heads no longer see the cycle-open notice.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   * budget_create_cycle (both overloads) — untouched.
--   * Department targeting semantics — untouched. The head loop reuses the exact
--     same target_department_ids filter as the existing department loop, so a
--     cycle can never notify a head of an untargeted department.
--   * budget_submit_submission, budget_department_route, all COO functions,
--     budget_finalize_submission, budget_request_revision, line decisions,
--     budget_submission_events, and every historical record.
--   * The department-level budget_department_notifications row is still written,
--     because it remains the canonical per-department audit record.
--
-- REUSE, NOT A PARALLEL WORKFLOW
-- budget_cycle_notifications already exists with exactly the right shape —
-- (call_id, department_id, user_id), UNIQUE (call_id, department_id, user_id),
-- FKs to budget_calls and hr_departments, and an RLS policy of
-- (user_id = auth.uid() OR is_budget_reviewer(auth.uid())). It holds 123 rows
-- from an earlier design and NO function writes to it. This migration revives it
-- rather than adding another table.
--
-- EXACTLY-ONCE DELIVERY (non-obvious, load-bearing)
-- budget_notify_cycle_open runs TWICE per cycle today: budget_create_cycle
-- PERFORMs it explicitly AND trg_budget_notify_cycle_open fires on the same
-- INSERT. The department insert is already idempotent via ON CONFLICT. The
-- personal notification is NOT idempotent, so budget_notify() is called ONLY
-- when the budget_cycle_notifications insert actually inserted a row (FOUND is
-- false when ON CONFLICT DO NOTHING suppressed it). Without that guard every
-- head would get two identical personal notifications.
--
-- SAFE FALLBACK
-- A department with no active designated head keeps today's visibility exactly.
-- This matters: two departments in the approved mapping do not exist yet (see
-- the seed note below), and without the fallback their notices would go dark.

-- 1. The mapping ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.budget_department_heads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.hr_departments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  is_primary    boolean NOT NULL DEFAULT true,
  active        boolean NOT NULL DEFAULT true,
  note          text,
  assigned_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_department_heads_unique UNIQUE (department_id, user_id)
);

CREATE INDEX IF NOT EXISTS budget_department_heads_dept_idx
  ON public.budget_department_heads (department_id) WHERE active;
CREATE INDEX IF NOT EXISTS budget_department_heads_user_idx
  ON public.budget_department_heads (user_id) WHERE active;

ALTER TABLE public.budget_department_heads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "budget heads readable" ON public.budget_department_heads;
CREATE POLICY "budget heads readable"
ON public.budget_department_heads FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_budget_reviewer(auth.uid()));

DROP POLICY IF EXISTS "budget heads manageable" ON public.budget_department_heads;
CREATE POLICY "budget heads manageable"
ON public.budget_department_heads FOR ALL TO authenticated
USING (public.is_budget_reviewer(auth.uid()))
WITH CHECK (public.is_budget_reviewer(auth.uid()));

GRANT SELECT ON public.budget_department_heads TO authenticated;
GRANT ALL    ON public.budget_department_heads TO service_role;

DROP TRIGGER IF EXISTS trg_budget_department_heads_touch ON public.budget_department_heads;
CREATE TRIGGER trg_budget_department_heads_touch
  BEFORE UPDATE ON public.budget_department_heads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Helper: is this user the designated head of this department?
CREATE OR REPLACE FUNCTION public.budget_is_department_head(_department_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.budget_department_heads h
     WHERE h.department_id = _department_id AND h.user_id = _user_id AND h.active
  );
$$;

-- Helper: does this department have ANY designated head? Drives the fallback.
CREATE OR REPLACE FUNCTION public.budget_department_has_head(_department_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.budget_department_heads h
     WHERE h.department_id = _department_id AND h.active
  );
$$;

-- 2. Seed the approved mapping ------------------------------------------
-- Each user_id was resolved from staff records (hr_staff / operations_departments
-- / staff_permissions), NOT from display name alone. "ATUHAIRE CAROLYNE" has a
-- non-staff namesake (7e506ac9-...) which is deliberately NOT used.
--
-- NOT SEEDED, and why:
--   * Human Resource Management -> Mark (bwayo mark, fe1e9f51-a2c3-49fc-bd40-b2c143afe628)
--     No HR department exists in hr_departments. Mark holds the "HR Lead"
--     position but his active assignment is to Engineering & Product, which
--     already has a different designated head (Joshua). Needs a business
--     decision, not a guess.
--   * Support & Security -> Rogers (Okello Nichodemus Rogers, 3b9311f3-9d4b-46a4-9c7c-aaef52af042e)
--     No "Support & Security" department exists. The nearest is
--     support_and_welfare ("Support and Welfare"), which is not the same thing.
--     Rogers' active assignment is to Operations, already headed by Joseph.
INSERT INTO public.budget_department_heads (department_id, user_id, note) VALUES
  ('560ddf17-189e-4dc8-92de-36701edbd411','b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c','Operations -> LUKODDA JOSEPH (Chief Operations Officer)'),
  ('6dd73f6a-5783-485e-b7fc-63716d1ecae7','cb798acb-68bc-4b4e-a414-a3d374e030b6','Engineering & Product -> JOSHUA WANDA (Chief Technical Officer)'),
  ('d76be2ac-fc3e-4f0a-9ab0-5c9ad6da2c6d','ae194750-4827-47e8-839e-5e772565138b','Partner Ops -> ATUHAIRE CAROLYNE (staff record; partner_ops)'),
  ('9e2e8c8e-2348-4e88-8507-2b916d47989c','5295252d-f477-42a9-92f5-af56e503e33d','Landlord Ops -> Gimono Jane Hephzibar'),
  ('7be5acd3-7d5d-4d84-8f86-35ca58f3666b','5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d','Tenant Ops -> Nsubuga Lawrence George'),
  ('3855b76d-2fb1-4590-88e9-178b3dbd4801','99890a2e-b842-4d44-8516-e2eafe0711ff','Agent Ops -> Grace Paul Ochieng')
ON CONFLICT (department_id, user_id) DO NOTHING;

-- 3. Deliver the cycle-open notice to designated heads -------------------
CREATE OR REPLACE FUNCTION public.budget_notify_cycle_open(_call_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_call budget_calls;
  v_sent int := 0;
  r record;
  h record;
BEGIN
  SELECT * INTO v_call FROM budget_calls WHERE id = _call_id;
  IF v_call.id IS NULL OR v_call.status <> 'open' THEN RETURN 0; END IF;

  FOR r IN SELECT d.id AS department_id, d.name AS department_name
             FROM hr_departments d
            WHERE d.active
              AND (v_call.target_department_ids IS NULL
                   OR cardinality(v_call.target_department_ids) = 0
                   OR d.id = ANY (v_call.target_department_ids))
  LOOP
    -- Department-level audit record. UNCHANGED.
    INSERT INTO budget_department_notifications(call_id, department_id, title, message, metadata)
    VALUES (
      _call_id,
      r.department_id,
      'Budget cycle open: ' || v_call.title,
      'The budget cycle "' || v_call.title || '" is open for ' || r.department_name || '. '
        || CASE WHEN v_call.deadline IS NOT NULL
                THEN 'Submit the departmental budget by '
                     || to_char(v_call.deadline AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI') || ' (EAT).'
                ELSE 'Submit the departmental budget on the Department Budgets page.' END,
      jsonb_build_object(
        'kind', 'budget_cycle_open',
        'call_id', _call_id,
        'cycle_title', v_call.title,
        'department_id', r.department_id,
        'department_name', r.department_name,
        'deadline', v_call.deadline,
        'link', '/budgets'
      )
    )
    ON CONFLICT (call_id, department_id) DO NOTHING;

    IF FOUND THEN v_sent := v_sent + 1; END IF;

    -- Personal delivery to the DESIGNATED HEAD(S) of this targeted department.
    -- Same target filter as above, so an untargeted department's head is never
    -- reached. Nothing happens for a department with no designated head.
    FOR h IN SELECT bh.user_id
               FROM budget_department_heads bh
              WHERE bh.department_id = r.department_id AND bh.active
    LOOP
      INSERT INTO budget_cycle_notifications(call_id, department_id, user_id)
      VALUES (_call_id, r.department_id, h.user_id)
      ON CONFLICT (call_id, department_id, user_id) DO NOTHING;

      -- Only on a genuine first insert: budget_notify writes to `notifications`,
      -- which has no idempotency key, and this function runs twice per cycle
      -- (explicit call + AFTER INSERT trigger).
      IF FOUND THEN
        PERFORM public.budget_notify(
          h.user_id,
          'Budget cycle open: ' || v_call.title,
          'You are the designated head for ' || r.department_name
            || '. The budget cycle "' || v_call.title || '" is open. '
            || CASE WHEN v_call.deadline IS NOT NULL
                    THEN 'Submit the departmental budget by '
                         || to_char(v_call.deadline AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI') || ' (EAT).'
                    ELSE 'Submit the departmental budget on the Department Budgets page.' END,
          jsonb_build_object(
            'kind', 'budget_cycle_open',
            'call_id', _call_id,
            'cycle_title', v_call.title,
            'department_id', r.department_id,
            'department_name', r.department_name,
            'deadline', v_call.deadline,
            'link', '/budgets'
          )
        );
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_sent;
END;
$function$;

-- 4. Restrict who can SEE the cycle-open notice --------------------------
-- Head-gated with fallback: where a department has designated heads, only they
-- (plus budget reviewers, who need oversight) see it. Where none is designated,
-- behaviour is exactly as before.
-- The DEFAULT NULL is part of the existing contract and must be preserved:
-- CREATE OR REPLACE cannot remove a parameter default, and callers rely on it.
CREATE OR REPLACE FUNCTION public.get_budget_department_notifications(
  _department_keys text[] DEFAULT NULL::text[]
)
RETURNS TABLE (
  id uuid, call_id uuid, department_id uuid, department_key text, department_name text,
  cycle_title text, deadline timestamptz, title text, message text, link text,
  created_at timestamptz, is_read boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT n.id,
         n.call_id,
         n.department_id,
         d.key AS department_key,
         d.name AS department_name,
         c.title AS cycle_title,
         c.deadline,
         n.title,
         n.message,
         COALESCE(n.metadata->>'link', '/budgets') AS link,
         n.created_at,
         EXISTS (
           SELECT 1 FROM budget_department_notification_reads rr
            WHERE rr.notification_id = n.id AND rr.user_id = auth.uid()
         ) AS is_read
    FROM budget_department_notifications n
    JOIN hr_departments d ON d.id = n.department_id
    JOIN budget_calls c ON c.id = n.call_id
   WHERE d.active
     AND public.budget_can_access_department(n.department_id, auth.uid())
     AND (
       NOT public.budget_department_has_head(n.department_id)
       OR public.budget_is_department_head(n.department_id, auth.uid())
       OR public.is_budget_reviewer(auth.uid())
     )
     AND (
       _department_keys IS NULL
       OR lower(d.key) IN (SELECT lower(k) FROM unnest(_department_keys) AS k)
     )
   ORDER BY n.created_at DESC
   LIMIT 50;
$function$;

-- The RPC is SECURITY DEFINER, but the table is also directly readable through
-- PostgREST, so the same rule is applied at the RLS layer. Otherwise the
-- restriction could be bypassed from the client.
DROP POLICY IF EXISTS "dept access can read budget dept notices" ON public.budget_department_notifications;
CREATE POLICY "dept access can read budget dept notices"
ON public.budget_department_notifications FOR SELECT TO authenticated
USING (
  public.budget_can_access_department(department_id, auth.uid())
  AND (
    NOT public.budget_department_has_head(department_id)
    OR public.budget_is_department_head(department_id, auth.uid())
    OR public.is_budget_reviewer(auth.uid())
  )
);

-- 5. Assertions ----------------------------------------------------------
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.budget_department_heads WHERE active;
  IF v_n < 6 THEN RAISE EXCEPTION 'expected at least 6 seeded heads, found %', v_n; END IF;

  -- One head per seeded department: no duplicate delivery by construction.
  SELECT count(*) INTO v_n FROM (
    SELECT department_id FROM public.budget_department_heads WHERE active
    GROUP BY department_id HAVING count(*) > 1
  ) x;
  IF v_n > 0 THEN RAISE EXCEPTION '% department(s) have multiple active heads', v_n; END IF;

  -- The workflow functions this change must not touch.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
   WHERE n2.nspname = 'public' AND p.proname IN
     ('budget_submit_submission','budget_coo_forward_submission','budget_coo_return_submission',
      'budget_finalize_submission','budget_request_revision','budget_department_route','budget_create_cycle');
  IF v_n < 7 THEN RAISE EXCEPTION 'workflow functions missing after migration: %', v_n; END IF;
END $$;
