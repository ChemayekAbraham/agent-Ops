-- Approval reminders every 4 hours (CFO 15 Nov 2026).
-- 1. Staff loan and facilitation reminders: "Later" now hides them for 4 hours (was 2), like requisitions.
--    The pop-ups no longer approve, decline or disburse; that happens in the approvals queue.
-- 2. Salary advances get a reminder for whoever holds the next step (none existed).
-- Preflight pins production's snooze functions of 15 Nov 2026. Rollback: supabase/rollbacks/20261124090000_approval_reminders_every_4_hours.rollback.sql

DO $pre$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.staff_loan_prompt_snooze(uuid)'::regprocedure)) <> 'e664e3bfb403e1486fc4ee38fafc9c8f'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.pso_facilitation_prompt_snooze(uuid)'::regprocedure)) <> 'af7e1e967c546888c5f96fab2bac9b49' THEN
    RAISE EXCEPTION 'precondition failed: a prompt snooze function is no longer production''s definition of 15 Nov 2026; re-derive this migration';
  END IF;
  IF to_regclass('public.hr_pay_advance_prompt_snoozes') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: already installed';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.staff_loan_prompt_snooze(_prompt_id uuid)
 RETURNS staff_loan_prompts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.staff_loan_prompts%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  update public.staff_loan_prompts
     set state='snoozed', snooze_until = now() + interval '4 hours',
         snooze_count = snooze_count + 1
   where id=_prompt_id and approver_id=auth.uid() and state <> 'resolved'
  returning * into v_row;
  if v_row.id is null then
    raise exception 'That approval prompt is not yours, or it has already been dealt with.';
  end if;
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.pso_facilitation_prompt_snooze(_prompt_id uuid)
 RETURNS pso_facilitation_prompts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.pso_facilitation_prompts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  update public.pso_facilitation_prompts
     set state        = 'snoozed',
         snooze_until = now() + interval '4 hours',
         snooze_count = snooze_count + 1
   where id = _prompt_id
     and approver_id = auth.uid()
     and state <> 'resolved'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'That approval prompt is not yours, or it has already been dealt with.';
  end if;

  return v_row;
end;
$function$;

-- Salary advances: a reminder for whoever holds the next step, every 4 hours, until it is dealt with.
--   requested    -> prepare authority (HR approval)
--   hr_approved  -> approve authority (CEO approval)
--   ceo_approved -> release authority (Pay to wallet)
-- Never for one's own advance. "Later" is kept on the server, per person, advance and step.
CREATE TABLE public.hr_pay_advance_prompt_snoozes (
  user_id      uuid        NOT NULL,
  advance_id   uuid        NOT NULL REFERENCES public.hr_pay_advances(id) ON DELETE CASCADE,
  status       text        NOT NULL,
  snooze_until timestamptz NOT NULL,
  snooze_count integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, advance_id, status)
);
ALTER TABLE public.hr_pay_advance_prompt_snoozes ENABLE ROW LEVEL SECURITY;
CREATE POLICY hr_pay_advance_prompt_snoozes_own_read ON public.hr_pay_advance_prompt_snoozes
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY mfa_required_for_staff ON public.hr_pay_advance_prompt_snoozes AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
REVOKE ALL ON TABLE public.hr_pay_advance_prompt_snoozes FROM anon, authenticated;
GRANT SELECT ON TABLE public.hr_pay_advance_prompt_snoozes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hr_pay_advance_prompt_snoozes TO service_role;

CREATE OR REPLACE FUNCTION public.hr_pay_advance_pending_prompt()
 RETURNS TABLE(advance_id uuid, status text, step text, staff_name text, staff_ref text, principal numeric, currency text,
               purpose text, requested_at timestamptz, snooze_count integer, total_pending integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_uid  uuid := auth.uid();
  v_prep boolean;
  v_appr boolean;
  v_rel  boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  v_prep := public.hr_pay_is_preparer();
  v_appr := public.hr_pay_is_approver();
  v_rel  := public.hr_pay_is_releaser();
  IF NOT (v_prep OR v_appr OR v_rel) THEN RETURN; END IF;
  RETURN QUERY
  WITH due AS (
    SELECT a.id AS aid, a.status AS st, a.principal AS amt, a.currency AS cur, a.purpose AS why, a.requested_at AS asked,
           s.user_id AS staff_user, s.staff_ref AS sref,
           CASE a.status WHEN 'requested' THEN 'hr' WHEN 'hr_approved' THEN 'ceo' ELSE 'cfo' END AS stp,
           COALESCE(z.snooze_count, 0) AS sc, z.snooze_until AS su
      FROM public.hr_pay_advances a
      JOIN public.hr_staff s ON s.id = a.staff_id
      LEFT JOIN public.hr_pay_advance_prompt_snoozes z ON z.user_id = v_uid AND z.advance_id = a.id AND z.status = a.status
     WHERE ((a.status = 'requested' AND v_prep) OR (a.status = 'hr_approved' AND v_appr) OR (a.status = 'ceo_approved' AND v_rel))
       AND s.user_id IS DISTINCT FROM v_uid
  )
  SELECT d.aid, d.st, d.stp, COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff member'), d.sref, d.amt, COALESCE(d.cur, 'UGX'),
         d.why, d.asked, d.sc, (SELECT count(*)::integer FROM due)
    FROM due d
    LEFT JOIN public.profiles p ON p.id = d.staff_user
   WHERE d.su IS NULL OR d.su <= now()
   ORDER BY d.asked, d.aid
   LIMIT 1;
END $function$;

CREATE OR REPLACE FUNCTION public.hr_pay_advance_prompt_snooze(p_advance_id uuid)
 RETURNS timestamptz
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_status text;
  v_until  timestamptz := now() + interval '4 hours';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in.' USING ERRCODE = '42501';
  END IF;
  SELECT a.status INTO v_status
    FROM public.hr_pay_advances a JOIN public.hr_staff s ON s.id = a.staff_id
   WHERE a.id = p_advance_id
     AND s.user_id IS DISTINCT FROM v_uid
     AND ((a.status = 'requested' AND public.hr_pay_is_preparer())
       OR (a.status = 'hr_approved' AND public.hr_pay_is_approver())
       OR (a.status = 'ceo_approved' AND public.hr_pay_is_releaser()));
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'That advance is not waiting on you, or it has already been dealt with.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.hr_pay_advance_prompt_snoozes AS z (user_id, advance_id, status, snooze_until, snooze_count)
  VALUES (v_uid, p_advance_id, v_status, v_until, 1)
  ON CONFLICT (user_id, advance_id, status)
  DO UPDATE SET snooze_until = EXCLUDED.snooze_until, snooze_count = z.snooze_count + 1, updated_at = now();
  RETURN v_until;
END $function$;

REVOKE ALL ON FUNCTION public.hr_pay_advance_pending_prompt() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.hr_pay_advance_prompt_snooze(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_pay_advance_pending_prompt() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hr_pay_advance_prompt_snooze(uuid) TO authenticated, service_role;
