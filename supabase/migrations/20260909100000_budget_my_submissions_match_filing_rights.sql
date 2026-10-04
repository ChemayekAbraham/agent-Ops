-- budget_my_submissions: list what the caller can actually file for.
--
-- THE DEFECT
-- The function hard-filtered to the caller's single HOME department:
--
--   CASE WHEN budget_home_department_id(auth.uid()) IS NOT NULL
--        THEN bs.department_id = budget_home_department_id(auth.uid())
--        ELSE bs.submitted_by_user_id = auth.uid()
--   END
--
-- budget_home_department_id() returns exactly ONE department and prefers the
-- primary hr_assignments row over the operations_departments link. Filing
-- rights, by contrast, come from budget_can_file_for_department(), which is
-- backed by budget_user_department_ids() — hr_assignments UNION
-- operations_departments, i.e. MANY departments.
--
-- That asymmetry meant a user could FILE for a department they could not LIST.
-- budget_save_draft() accepted the draft (it checks
-- budget_can_file_for_department), but budget_my_submissions() then refused to
-- return it, so the draft was invisible to its own author and could never be
-- reopened, edited or submitted.
--
-- WHO IT BROKE (observed in production 2026-09-09)
-- Four of the six designated budget heads are HR-assigned to `operations`
-- while heading an ops department, so their home department resolved to
-- Operations rather than the department they head:
--
--   Nsubuga Lawrence George  heads tenant_ops    home -> operations
--   Grace Paul Ochieng       heads agent_ops     home -> operations
--   Gimono Jane Hephzibar    heads landlord_ops  home -> operations
--   ATUHAIRE CAROLYNE        heads partner_ops   home -> operations
--
-- Each received the cycle-open notice for their department, could select it in
-- the form, and could create a draft — which then vanished from their list.
-- JOSHUA WANDA (engineering) and LUKODDA JOSEPH (operations) were unaffected
-- because their home department already matched.
--
-- THE FIX
-- List exactly what the caller may file for, plus anything they submitted
-- themselves. This is NOT a widening of authorisation: it aligns the listing
-- with the authorisation model that already governs access to an individual
-- submission. can_access_budget_submission() already grants read/edit on any
-- submission whose department satisfies budget_can_file_for_department(), so
-- budget_my_submissions() was the outlier — strictly more restrictive than the
-- permission check applied when the same row is opened directly.
--
-- DELIBERATELY NOT INCLUDED
-- is_budget_reviewer() is NOT added here. This is the caller's own
-- department-facing feed; reviewers have budget_review_queue() for oversight.
-- Adding it would dump every department's submissions into a personal list.
-- A reviewer filing on behalf of another department is still covered, because
-- they match the submitted_by_user_id branch.
--
-- The HR data is untouched: no assignment is re-pointed, no head mapping is
-- changed, and no historical submission, event or notification is modified.
-- Signature, return type, volatility, SECURITY DEFINER, search_path and the
-- p_call_id default are all preserved so no caller changes.

CREATE OR REPLACE FUNCTION public.budget_my_submissions(p_call_id uuid DEFAULT NULL::uuid)
RETURNS SETOF public.budget_submissions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT bs.*
    FROM budget_submissions bs
   WHERE (p_call_id IS NULL OR bs.call_id = p_call_id)
     AND (
       -- Anything the caller filed themselves, including on behalf of another
       -- department as a reviewer.
       bs.submitted_by_user_id = auth.uid()
       -- Anything belonging to a department the caller is registered in, which
       -- is precisely the set budget_can_file_for_department() allows.
       OR EXISTS (
         SELECT 1 FROM public.budget_user_department_ids(auth.uid()) AS d(id)
          WHERE d.id = bs.department_id
       )
     )
   ORDER BY bs.created_at DESC;
$function$;

DO $$
DECLARE v_n integer;
BEGIN
  -- The home-department filter must be gone, and filing-rights resolution present.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'budget_my_submissions'
     AND position('budget_home_department_id' in p.prosrc) = 0
     AND position('budget_user_department_ids' in p.prosrc) > 0;
  IF v_n <> 1 THEN RAISE EXCEPTION 'budget_my_submissions not rewritten as expected'; END IF;

  -- Exactly one overload, contract intact.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'budget_my_submissions';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 budget_my_submissions, found %', v_n; END IF;

  -- Filing and routing behaviour must be untouched by this migration.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN
     ('budget_save_draft','budget_submit_submission','budget_can_file_for_department',
      'budget_home_department_id','budget_user_department_ids','can_access_budget_submission');
  IF v_n < 6 THEN RAISE EXCEPTION 'supporting functions missing: %', v_n; END IF;
END $$;
