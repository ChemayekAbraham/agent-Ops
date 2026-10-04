CREATE OR REPLACE FUNCTION public.credit_recruiter_override(
  p_sub_agent_id uuid,
  p_event_type text,
  p_source_table text,
  p_source_id text,
  p_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_recruiter uuid;
  v_amount NUMERIC := 3000;
  v_idem TEXT;
  v_group_id uuid;
  v_desc TEXT;
  v_reason TEXT;
  v_already BOOLEAN;
BEGIN
  IF p_sub_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_sub_agent');
  END IF;

  -- Find the agent who recruited this sub-agent
  SELECT parent_agent_id INTO v_recruiter
  FROM public.agent_subagents
  WHERE sub_agent_id = p_sub_agent_id
    AND status = 'verified'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_recruiter IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_recruiter');
  END IF;

  -- Never pay the recruiter for their own work
  IF v_recruiter = p_sub_agent_id THEN
    RETURN jsonb_build_object('status','skipped','reason','self');
  END IF;

  -- Human-readable reason per event type (used in ledger + notification)
  v_reason := CASE p_event_type
    WHEN 'house_listed_verified'      THEN 'an empty house your sub-agent listed was verified'
    WHEN 'landlord_verified'          THEN 'a landlord your sub-agent registered was verified'
    WHEN 'lc1_chairperson_verified'   THEN 'an LC1 chairperson your sub-agent registered was verified'
    WHEN 'tenant_landlord_funded'     THEN 'your sub-agent''s tenant got its landlord funded for the first time'
    ELSE 'your sub-agent completed a verified action'
  END;

  v_desc := 'UGX 3,000 recruiter override - ' || p_event_type ||
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
          'description', v_desc,
          'currency', 'UGX'
        ),
        jsonb_build_object(
          'user_id', v_recruiter,
          'amount', v_amount,
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'ledger_scope', 'platform',
          'source_table', p_source_table,
          'source_id', p_source_id,
          'description', 'Platform expense: ' || v_desc,
          'currency', 'UGX'
        )
      ),
      v_idem
    );
  EXCEPTION WHEN OTHERS THEN
    -- Log a failure event so the recruiter sees a clear error toast
    INSERT INTO public.recruiter_override_events
      (recruiter_id, sub_agent_id, event_type, source_table, source_id, label, amount, status, error_message)
    VALUES
      (v_recruiter, p_sub_agent_id, p_event_type, p_source_table, p_source_id, p_label, v_amount, 'failed', SQLERRM);
    RETURN jsonb_build_object('status','error','recruiter_id',v_recruiter,'message',SQLERRM);
  END;

  -- Log the success event (idempotent on event_type + source_id)
  INSERT INTO public.recruiter_override_events
    (recruiter_id, sub_agent_id, event_type, source_table, source_id, label, amount, status)
  VALUES
    (v_recruiter, p_sub_agent_id, p_event_type, p_source_table, p_source_id, p_label, v_amount, 'credited')
  ON CONFLICT (event_type, source_id) WHERE (status = 'credited') DO NOTHING;

  GET DIAGNOSTICS v_already = ROW_COUNT;

  -- Persistent in-app notification with a clear bonus breakdown (only on the
  -- first credited insert, so the bell never duplicates the same payout).
  IF v_already THEN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      v_recruiter,
      'Recruiter override earned: UGX 3,000 🎉',
      'Bonus breakdown:' || E'\n' ||
      '• Why: ' || v_reason || COALESCE(' (' || p_label || ')', '') || E'\n' ||
      '• Amount: UGX 3,000' || E'\n' ||
      '• Source: Welile company funds' || E'\n' ||
      '• Where: added to your withdrawable wallet',
      'success',
      jsonb_build_object(
        'kind', 'recruiter_override',
        'event_type', p_event_type,
        'sub_agent_id', p_sub_agent_id,
        'source_table', p_source_table,
        'source_id', p_source_id,
        'amount', v_amount
      )
    );
  END IF;

  RETURN jsonb_build_object('status','credited','recruiter_id',v_recruiter,'amount',v_amount,'group_id',v_group_id);
END;
$function$;