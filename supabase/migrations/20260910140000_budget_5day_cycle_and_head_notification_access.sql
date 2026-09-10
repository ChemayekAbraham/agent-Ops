-- =====================================================================
-- Budget: 5-day cycle submissions, clickable notices, head notice access
-- =====================================================================
-- Three independent defects that together stopped designated department
-- heads from filing a budget. All were applied to production 2026-09-10;
-- every block here is idempotent, so a fresh replay reproduces the same
-- end state and re-running against the patched database is a no-op.
--
-- No accounting logic, approval routing, or submission workflow is changed.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. budget_submissions accepted a narrower period_type than budget_calls
--
--    budget_calls  CHECK (... 'monthly','quarterly','yearly','5days')
--    budget_submissions CHECK (... 'monthly','quarterly','yearly')   <- '5days' missing
--
--    budget_save_draft copies v_call.period_type onto the submission, so
--    every attempt to file against the open 5-day cycle failed the child
--    constraint. The only open cycle was period_type='5days', which is why
--    it had 0 submissions and 0 drafts while every monthly cycle had rows.
--    Presented to users as "the Submit button does nothing", because
--    submit() persists the draft first and surfaced the raw Postgres error.
-- ---------------------------------------------------------------------
DO $mig$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public'
       AND rel.relname = 'budget_submissions'
       AND con.conname = 'budget_submissions_period_type_check'
       AND pg_get_constraintdef(con.oid) NOT LIKE '%5days%'
  ) THEN
    ALTER TABLE public.budget_submissions
      DROP CONSTRAINT budget_submissions_period_type_check,
      ADD  CONSTRAINT budget_submissions_period_type_check
           CHECK (period_type = ANY (ARRAY['monthly'::text,'quarterly'::text,'yearly'::text,'5days'::text]));
  END IF;
END
$mig$;


-- ---------------------------------------------------------------------
-- 2. Budget notices carried no destination
--
--    budget_notify inserted only (user_id, title, message, type, metadata),
--    leaving notifications.link_path NULL. The URL existed solely as
--    metadata.link, which no frontend code read, so tapping a budget notice
--    did nothing.
--
--    Now link_path is derived so the notice opens the submission form
--    already scoped to the cycle/department that owes the budget.
--    /budgets reads cycle, department and submission as search params.
--
--    Reviewer-stage notices ('coo'/'cfo') are deliberately left WITHOUT a
--    link: their review queues live elsewhere, and pointing an approver at
--    the submission form would mis-route them. Approval routing unchanged.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.budget_notify(_user_id uuid, _title text, _message text, _meta jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_meta jsonb := COALESCE(_meta, '{}'::jsonb);
  v_link text;
BEGIN
  IF _user_id IS NULL THEN RETURN; END IF;

  IF v_meta ? 'stage' THEN
    v_link := NULL;
  ELSIF NULLIF(v_meta->>'submission_id','') IS NOT NULL THEN
    v_link := '/budgets?submission=' || (v_meta->>'submission_id');
  ELSIF NULLIF(v_meta->>'call_id','') IS NOT NULL
        AND NULLIF(v_meta->>'department_id','') IS NOT NULL THEN
    v_link := '/budgets?cycle=' || (v_meta->>'call_id')
              || '&department=' || (v_meta->>'department_id');
  ELSE
    v_link := NULL;
  END IF;

  INSERT INTO notifications(user_id, title, message, type, metadata, link_path)
  VALUES (_user_id, _title, _message, 'budget', v_meta, v_link);
EXCEPTION WHEN OTHERS THEN RETURN;
END;
$function$;


-- ---------------------------------------------------------------------
-- 3. A designated head could not see their own department's notice
--
--    budget_can_access_department resolved access only through
--    operations_departments or a staff_permissions dashboard mapping. That
--    mapping has no entry producing 'human_resources' at all ('hr' maps to
--    interns + support_and_welfare), so the Head of HR failed the gate in
--    get_budget_department_notifications even though he IS the designated
--    head -- his department notice existed but was invisible to him.
--
--    Adding the head clause is purely additive: it can only grant, never
--    revoke. Verified at the time of writing that the Head of HR was the
--    only head of eight who failed; the other seven already passed and are
--    unaffected.
--
--    NOTE: the _user_id DEFAULT auth.uid() must be preserved -- an RLS
--    policy on budget_department_notifications depends on this function.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.budget_can_access_department(_department_id uuid, _user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM budget_department_heads bh
      JOIN hr_departments d ON d.id = bh.department_id
     WHERE bh.department_id = _department_id
       AND bh.user_id = _user_id
       AND bh.active
       AND d.active
  )
  OR EXISTS (
    SELECT 1
      FROM operations_departments od
      JOIN hr_departments d ON lower(d.key) = lower(od.department)
     WHERE d.id = _department_id
       AND d.active
       AND od.user_id = _user_id
  )
  OR EXISTS (
    SELECT 1
      FROM staff_permissions sp
      JOIN hr_departments d ON d.id = _department_id
     WHERE sp.user_id = _user_id
       AND sp.revoked_at IS NULL
       AND d.active
       AND lower(d.key) = ANY (
         CASE lower(sp.permitted_dashboard)
           WHEN 'tenant-ops' THEN ARRAY['tenant_ops']
           WHEN 'agent-ops' THEN ARRAY['agent_ops']
           WHEN 'landlord-ops' THEN ARRAY['landlord_ops']
           WHEN 'partner-ops' THEN ARRAY['partner_ops']
           WHEN 'partners-ops' THEN ARRAY['partner_ops']
           WHEN 'cfo' THEN ARRAY['finance']
           WHEN 'financial-ops' THEN ARRAY['finance']
           WHEN 'cmo' THEN ARRAY['marketing']
           WHEN 'cto' THEN ARRAY['engineering','product_research_and_development']
           WHEN 'coo' THEN ARRAY['operations']
           WHEN 'company-ops' THEN ARRAY['operations']
           WHEN 'ceo' THEN ARRAY['board_of_directors']
           WHEN 'director' THEN ARRAY['board_of_directors']
           WHEN 'hr' THEN ARRAY['interns','support_and_welfare']
           WHEN 'crm' THEN ARRAY['partnership']
           ELSE ARRAY[]::text[]
         END
       )
  );
$function$;


-- ---------------------------------------------------------------------
-- Deliberately NOT in this migration (production data, not schema):
--   * budget_department_heads rows designating the Heads of Marketing and
--     Human Resources
--   * the Human Resources entry added to the open cycle's
--     budget_calls.target_department_ids
--   * the budget_department_notifications / budget_cycle_notifications /
--     notifications rows raised for those two heads
-- Those are operational records for one specific cycle and must not be
-- replayed into another environment.
-- ---------------------------------------------------------------------
