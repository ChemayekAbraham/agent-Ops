
-- 1) Fix recruiter override amount to 3,000 going forward
CREATE OR REPLACE FUNCTION public.credit_recruiter_override(
  p_sub_agent_id uuid,
  p_event_type text,
  p_source_table text,
  p_source_id text,
  p_label text DEFAULT NULL::text
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
    INSERT INTO public.recruiter_override_events
      (recruiter_id, sub_agent_id, event_type, source_table, source_id, label, amount, status, error_message)
    VALUES
      (v_recruiter, p_sub_agent_id, p_event_type, p_source_table, p_source_id, p_label, v_amount, 'failed', SQLERRM);
    RETURN jsonb_build_object('status','failed','reason', SQLERRM);
  END;

  INSERT INTO public.recruiter_override_events
    (recruiter_id, sub_agent_id, event_type, source_table, source_id, label, amount, status, ledger_group_id)
  VALUES
    (v_recruiter, p_sub_agent_id, p_event_type, p_source_table, p_source_id, p_label, v_amount, 'paid', v_group_id)
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','paid','recruiter_id', v_recruiter, 'amount', v_amount, 'reason', v_reason);
END;
$function$;

-- 2) Top up Watsala Enock for 8 underpaid overrides today: +UGX 2,000 × 8 = 16,000
DO $$
DECLARE
  v_user uuid := 'ebf0897b-dfdf-4403-ad5c-1c988c72e67c';
  v_group uuid;
BEGIN
  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_user,
        'amount', 16000,
        'direction', 'cash_in',
        'category', 'agent_commission',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'source_table', 'recruiter_override_events',
        'source_id', gen_random_uuid()::text,
        'description', 'Recruiter override top-up: 8 events × UGX 2,000 (underpaid at 1,000 instead of 3,000) — 2026-07-27',
        'currency', 'UGX'
      ),
      jsonb_build_object(
        'user_id', v_user,
        'amount', 16000,
        'direction', 'cash_out',
        'category', 'marketing_expense',
        'ledger_scope', 'platform',
        'source_table', 'recruiter_override_events',
        'source_id', gen_random_uuid()::text,
        'description', 'Platform expense: recruiter override top-up (Watsala Enock, 8× UGX 2,000)',
        'currency', 'UGX'
      )
    ),
    'recruiter_override_topup:ebf0897b:2026-07-27'
  );
END $$;
