CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(
  p_agent_id uuid,
  p_event_type text,
  p_tenant_id uuid DEFAULT NULL::uuid,
  p_source_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_amount NUMERIC;
  v_description TEXT;
  v_row_id UUID;
  v_now TIMESTAMPTZ := now();
  v_group_id UUID;
  v_idem TEXT;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_agent');
  END IF;

  v_amount := CASE p_event_type
    WHEN 'rent_request_posted'        THEN 5000
    WHEN 'house_listed'               THEN 2000
    WHEN 'tenant_replacement'         THEN 20000
    WHEN 'subagent_registration'      THEN 10000
    WHEN 'service_centre_setup'       THEN 25000
    WHEN 'three_verified_houses'      THEN 10000
    WHEN 'tenant_placement'           THEN 10000
    WHEN 'rent_funded_landlord_float' THEN 10000
    ELSE NULL
  END;

  IF v_amount IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Unknown event_type: ' || p_event_type);
  END IF;

  v_description := CASE p_event_type
    WHEN 'rent_request_posted'        THEN 'Bonus: Rent request posted'
    WHEN 'house_listed'               THEN 'Bonus: Empty house listed'
    WHEN 'tenant_replacement'         THEN 'Bonus: Tenant replacement'
    WHEN 'subagent_registration'      THEN 'Bonus: Sub-agent registration'
    WHEN 'service_centre_setup'       THEN 'Bonus: Service Centre setup'
    WHEN 'three_verified_houses'      THEN 'Bonus: Sub-agent listed 3 verified houses'
    WHEN 'tenant_placement'           THEN 'Bonus: Tenant placement'
    WHEN 'rent_funded_landlord_float' THEN 'Bonus: Landlord float disbursed for registered tenant'
  END;

  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commission_accrual_ledger
    WHERE source_id = p_source_id AND agent_id = p_agent_id AND event_type = p_event_type
  ) THEN
    RETURN jsonb_build_object('status', 'already_credited');
  END IF;

  INSERT INTO commission_accrual_ledger (
    agent_id, event_type, commission_role, source_type, tenant_id, source_id,
    amount, description, status, earned_at, created_at
  ) VALUES (
    p_agent_id, p_event_type, 'event_bonus', p_event_type, p_tenant_id, p_source_id,
    v_amount, v_description, 'pending', v_now, v_now
  )
  RETURNING id INTO v_row_id;

  -- Pay through the ledger. apply_wallet_movement no longer writes buckets
  -- (ledger is the sole source of truth), and its old parameter list is gone —
  -- calling it here is what aborted landlord-float funding transactions.
  v_idem := 'agent_event_bonus:' || p_event_type || ':' || COALESCE(p_source_id, v_row_id::text);

  BEGIN
    v_group_id := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', p_agent_id,
          'amount', v_amount,
          'direction', 'cash_in',
          'category', 'agent_commission',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'source_table', 'commission_accrual_ledger',
          'source_id', v_row_id::text,
          'description', v_description
        ),
        jsonb_build_object(
          'user_id', p_agent_id,
          'amount', v_amount,
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'ledger_scope', 'platform',
          'source_table', 'commission_accrual_ledger',
          'source_id', v_row_id::text,
          'description', 'Marketing expense: ' || v_description
        )
      ),
      v_idem
    );
  EXCEPTION WHEN unique_violation THEN
    UPDATE commission_accrual_ledger
    SET status = 'credited', paid_at = v_now
    WHERE id = v_row_id;
    RETURN jsonb_build_object('status', 'already_credited', 'event_type', p_event_type);
  END;

  UPDATE commission_accrual_ledger
  SET status = 'credited', paid_at = v_now
  WHERE id = v_row_id;

  RETURN jsonb_build_object(
    'status', 'credited',
    'event_type', p_event_type,
    'amount', v_amount,
    'description', v_description,
    'transaction_group_id', v_group_id
  );
END;
$function$;