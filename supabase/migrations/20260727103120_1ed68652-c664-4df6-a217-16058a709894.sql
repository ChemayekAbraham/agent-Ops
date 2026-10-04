CREATE OR REPLACE FUNCTION public.credit_recruiter_override(p_sub_agent_id uuid, p_event_type text, p_source_table text, p_source_id text, p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_recruiter uuid;
  v_amount NUMERIC;
  v_idem TEXT;
  v_group_id uuid;
  v_desc TEXT;
  v_reason TEXT;
BEGIN
  IF p_sub_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_sub_agent');
  END IF;

  SELECT parent_agent_id INTO v_recruiter
  FROM public.agent_subagents
  WHERE sub_agent_id = p_sub_agent_id
    AND status = 'verified'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_recruiter IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_recruiter');
  END IF;

  IF v_recruiter = p_sub_agent_id THEN
    RETURN jsonb_build_object('status','skipped','reason','self');
  END IF;

  v_amount := CASE p_event_type
    WHEN 'house_listed_verified' THEN 2000
    ELSE 3000
  END;

  v_reason := CASE p_event_type
    WHEN 'house_listed_verified'      THEN 'an empty house your sub-agent listed was verified'
    WHEN 'landlord_verified'          THEN 'a landlord your sub-agent registered was verified'
    WHEN 'lc1_chairperson_verified'   THEN 'an LC1 chairperson your sub-agent registered was verified'
    WHEN 'tenant_landlord_funded'     THEN 'your sub-agent''s tenant got its landlord funded for the first time'
    ELSE 'your sub-agent completed a verified action'
  END;

  v_desc := 'UGX ' || to_char(v_amount,'FM999,999') || ' recruiter override - ' || p_event_type ||
            COALESCE(' (' || p_label || ')', '');

  v_idem := 'recruiter_override:' || p_event_type || ':' || p_source_id;

  BEGIN
    v_group_id := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_recruiter,
          'amount', v_amount,
          'direction', 'cash_in',
          'category', 'agent_commission',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'source_table', p_source_table,
          'source_id', p_source_id,
          'description', v_desc
        ),
        jsonb_build_object(
          'user_id', v_recruiter,
          'amount', v_amount,
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'ledger_scope', 'platform',
          'source_table', p_source_table,
          'source_id', p_source_id,
          'description', v_desc
        )
      ),
      v_idem
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status','skipped','reason','duplicate');
  END;

  RETURN jsonb_build_object('status','ok','amount',v_amount,'recruiter',v_recruiter,'group_id',v_group_id);
END;
$function$;