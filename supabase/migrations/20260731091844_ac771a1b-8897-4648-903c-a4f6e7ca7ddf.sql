CREATE OR REPLACE FUNCTION public.credit_recruiter_override(p_subagent_id uuid, p_event_type text, p_ref_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_recruiter UUID;
  v_amount NUMERIC;
  v_group_id UUID;
  v_desc TEXT;
  v_exists BOOLEAN;
BEGIN
  IF p_subagent_id IS NULL OR p_ref_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','missing_input');
  END IF;

  SELECT parent_agent_id INTO v_recruiter
  FROM public.agent_subagents
  WHERE subagent_id = p_subagent_id
    AND status = 'active'
  LIMIT 1;

  IF v_recruiter IS NULL OR v_recruiter = p_subagent_id THEN
    RETURN jsonb_build_object('status','skipped','reason','no_recruiter');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE category = 'recruiter_override'
      AND metadata->>'ref_id' = p_ref_id::text
      AND metadata->>'event_type' = p_event_type
  ) INTO v_exists;

  IF v_exists THEN
    RETURN jsonb_build_object('status','skipped','reason','already_paid');
  END IF;

  v_amount := 2000;

  v_group_id := gen_random_uuid();
  v_desc := 'UGX ' || to_char(v_amount,'FM999,999') || ' recruiter override - ' || p_event_type ||
            ' by sub-agent';

  PERFORM public.create_ledger_transaction(
    v_group_id,
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_recruiter,
        'scope', 'wallet',
        'category', 'recruiter_override',
        'cash_in', v_amount,
        'cash_out', 0,
        'amount', v_amount,
        'recipient_type', 'user',
        'description', v_desc,
        'metadata', jsonb_build_object('ref_id', p_ref_id, 'event_type', p_event_type, 'subagent_id', p_subagent_id)
      ),
      jsonb_build_object(
        'scope', 'platform',
        'category', 'recruiter_override',
        'cash_in', 0,
        'cash_out', v_amount,
        'amount', v_amount,
        'description', v_desc,
        'metadata', jsonb_build_object('ref_id', p_ref_id, 'event_type', p_event_type, 'subagent_id', p_subagent_id)
      )
    )
  );

  RETURN jsonb_build_object('status','ok','amount',v_amount,'recruiter',v_recruiter,'group_id',v_group_id);
END;
$function$;