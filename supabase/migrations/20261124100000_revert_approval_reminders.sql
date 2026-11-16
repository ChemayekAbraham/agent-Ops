-- Revert of 20261124090000_approval_reminders_every_4_hours (CFO instruction 16 Nov 2026: revert the staff loan,
-- facilitation and salary advance reminder changes; requisition reminders are unchanged).
-- Restores production's staff loan and facilitation snooze functions of 15 Nov 2026 ("Later" = 2 hours) verbatim and
-- removes the salary advance reminder (its table, which holds only snooze times, and its two functions).
-- Preflight pins the functions as 20261124090000 left them.
DO $pre$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.staff_loan_prompt_snooze(uuid)'::regprocedure)) <> 'e177a854c15aa80e97409a9b57ba4feb'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.pso_facilitation_prompt_snooze(uuid)'::regprocedure)) <> '0fff613a53fe9341fa330a99b9763eaa' THEN
    RAISE EXCEPTION 'precondition failed: the snooze functions are not as 20261124090000 left them; re-derive this revert';
  END IF;
  IF to_regclass('public.hr_pay_advance_prompt_snoozes') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 20261124090000 is not installed (already reverted?)';
  END IF;
END $pre$;

DROP FUNCTION IF EXISTS public.hr_pay_advance_prompt_snooze(uuid);
DROP FUNCTION IF EXISTS public.hr_pay_advance_pending_prompt();
DROP TABLE IF EXISTS public.hr_pay_advance_prompt_snoozes;
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
     set state='snoozed', snooze_until = now() + interval '2 hours',
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
         snooze_until = now() + interval '2 hours',
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
