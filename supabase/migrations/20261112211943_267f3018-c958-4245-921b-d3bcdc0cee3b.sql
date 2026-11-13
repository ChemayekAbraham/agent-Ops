CREATE OR REPLACE FUNCTION public.staff_requisition_prompt_snooze(p_prompt_id uuid DEFAULT NULL::uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_until     timestamptz := now() + interval '4 hours';
  v_req_id    uuid;
  v_requester uuid;
  v_code      text;
  v_stage     text;
  v_office    text;
  v_name      text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in.';
  END IF;

  UPDATE public.staff_requisition_prompts
     SET state = 'snoozed',
         snooze_until = v_until,
         snooze_count = snooze_count + 1
   WHERE approver_id = auth.uid()
     AND state <> 'resolved';

  IF p_prompt_id IS NOT NULL THEN
    SELECT r.id, r.requester_id, r.requisition_code, p.stage
      INTO v_req_id, v_requester, v_code, v_stage
      FROM public.staff_requisition_prompts p
      JOIN public.staff_requisitions r ON r.id = p.requisition_id
     WHERE p.id = p_prompt_id
       AND p.approver_id = auth.uid()
       AND r.stage = p.stage;

    IF v_req_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff_requisition_notices n
       WHERE n.requisition_id = v_req_id
         AND n.kind = 'deferred'
         AND n.from_stage = v_stage
         AND (n.created_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date
    ) THEN
      v_office := CASE v_stage WHEN 'supervisor' THEN 'Department head' WHEN 'coo' THEN 'COO'
                    WHEN 'ceo' THEN 'CEO' WHEN 'cfo' THEN 'CFO' ELSE upper(coalesce(v_stage, '')) END;
      SELECT full_name INTO v_name FROM public.profiles WHERE id = auth.uid();
      INSERT INTO public.staff_requisition_notices
        (requisition_id, recipient_id, kind, from_stage, to_stage, actor_name, title, body)
      VALUES (v_req_id, v_requester, 'deferred', v_stage, v_stage, v_name,
        v_code || ' set aside for now',
        'The ' || v_office || ' (' || coalesce(v_name, '') || ') has seen your requisition and set it aside for now. It is still with them and they will be reminded.');
    END IF;
  END IF;

  RETURN v_until;
END
$function$;