-- Verbatim production copies (15 Nov 2026, read-only export) of the staff loan and facilitation prompt snooze functions.
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
