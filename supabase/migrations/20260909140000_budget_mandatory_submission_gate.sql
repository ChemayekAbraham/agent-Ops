-- Authoritative state for the mandatory budget-submission gate.
--
-- WHAT THIS IS
-- One SECURITY DEFINER RPC answering, for the CALLER only: "do you have an
-- outstanding budget submission that must block your use of the system?"
-- The frontend gate reads this and nothing else, so refreshing, deep-linking to
-- a route, or signing out and back in cannot bypass it — there is no
-- client-held flag to tamper with.
--
-- THIS MIGRATION IS INERT ON ITS OWN. It adds a read-only function. Nothing
-- calls it until the overlay component is mounted, so applying this changes no
-- behaviour for any user.
--
-- WHO IS "DESIGNATED" — derived, never hard-coded
--   open cycle (budget_calls.status='open')
--     -> department targeted by that cycle (target_department_ids, NULL = all)
--       -> caller is an ACTIVE head of that department (budget_department_heads)
-- This reuses the same mapping that already drives cycle-open notifications and
-- first-level approval routing. Adding or moving a head is a row change in
-- budget_department_heads; no code change, and no user or department is named
-- anywhere in this function.
--
-- WHEN IS THE OBLIGATION SATISFIED (gate releases)
-- A submission exists for that (call_id, department_id) whose status has moved
-- past draft:
--   pending_coo, coo_under_review, submitted, under_review, approved, rejected
--
-- Deliberate choices in that list:
--   * 'draft' does NOT satisfy it — saving a draft is not submitting, and the
--     requirement is to block until the budget is submitted.
--   * 'revision_requested' does NOT satisfy it — budget_coo_return_submission
--     and budget_request_revision both create a fresh draft version, so the
--     department genuinely owes a resubmission and should be blocked again.
--   * 'rejected' DOES satisfy it — that is a final decision. Re-blocking
--     someone over a budget that was rejected outright would leave them with no
--     action that can clear the gate.
--
-- SAFETY NOTE FOR WHOEVER MOUNTS THE UI
-- This is a hard, application-wide access gate. If it ever resolves wrongly the
-- affected user cannot reach any page to fix it. Two recovery levers, both
-- data-only and immediate:
--   1. UPDATE budget_department_heads SET active=false  -- de-designate a user
--   2. UPDATE budget_calls SET status='closed'          -- close the cycle
-- The gate reads live state, so either clears it on the user's next request.
-- The overlay should also fail OPEN (render children) on query error or while
-- loading, never fail closed — a transient network error must not lock the
-- application.

CREATE OR REPLACE FUNCTION public.budget_my_outstanding_obligations()
RETURNS TABLE (
  call_id            uuid,
  cycle_title        text,
  deadline           timestamptz,
  department_id      uuid,
  department_name    text,
  department_key     text,
  draft_submission_id uuid,
  is_overdue         boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT c.id            AS call_id,
         c.title         AS cycle_title,
         c.deadline,
         d.id            AS department_id,
         d.name          AS department_name,
         d.key           AS department_key,
         -- Existing draft, if any, so the primary action can resume it rather
         -- than starting a second empty submission.
         (SELECT s.id FROM budget_submissions s
           WHERE s.call_id = c.id AND s.department_id = d.id AND s.status = 'draft'
           ORDER BY s.version DESC, s.created_at DESC LIMIT 1) AS draft_submission_id,
         (c.deadline IS NOT NULL AND now() > c.deadline) AS is_overdue
    FROM budget_calls c
    JOIN budget_department_heads h
      ON h.active
     AND h.user_id = auth.uid()
    JOIN hr_departments d
      ON d.id = h.department_id
     AND d.active
   WHERE c.status = 'open'
     -- Only departments this cycle actually targets. NULL/empty = every
     -- department, matching budget_notify_cycle_open.
     AND (c.target_department_ids IS NULL
          OR cardinality(c.target_department_ids) = 0
          OR d.id = ANY (c.target_department_ids))
     -- Outstanding = nothing submitted past draft for this cycle+department.
     AND NOT EXISTS (
       SELECT 1 FROM budget_submissions s
        WHERE s.call_id = c.id
          AND s.department_id = d.id
          AND s.status IN ('pending_coo','coo_under_review','submitted',
                           'under_review','approved','rejected')
     )
   ORDER BY c.deadline NULLS LAST, c.created_at;
$function$;

REVOKE ALL ON FUNCTION public.budget_my_outstanding_obligations() FROM public;
GRANT EXECUTE ON FUNCTION public.budget_my_outstanding_obligations() TO authenticated;

COMMENT ON FUNCTION public.budget_my_outstanding_obligations() IS
  'Authoritative per-caller list of open budget cycles the caller must still submit for, as an active designated department head. Drives the mandatory submission gate. Reads auth.uid() only - never accepts a user id, so it cannot be used to probe another user.';

DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'budget_my_outstanding_obligations';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 budget_my_outstanding_obligations, found %', v_n; END IF;

  -- No user or department may be named in the body.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'budget_my_outstanding_obligations'
     AND p.prosrc ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  IF v_n <> 0 THEN RAISE EXCEPTION 'function contains a hard-coded uuid'; END IF;

  -- Nothing in the existing workflow may have been touched.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN
     ('budget_create_cycle','budget_save_draft','budget_submit_submission',
      'budget_department_route','budget_my_submissions','budget_review_queue',
      'budget_finalize_submission','budget_notify_cycle_open');
  IF v_n < 8 THEN RAISE EXCEPTION 'existing budget workflow functions missing: %', v_n; END IF;
END $$;
