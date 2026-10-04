CREATE OR REPLACE FUNCTION public.fin_ops_set_cash_location(p_deposit_request_id uuid, p_location text, p_note text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_loc text;
  v_prev text;
  v_dep record;
  v_seq int;
  v_group uuid;
  v_ref text;
  v_audit jsonb := '{}'::jsonb;
  v_has_transit boolean;
  v_has_a1_debit boolean;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_loc := CASE WHEN p_location = 'bank' THEN 'bank' ELSE 'cash_at_hand' END;

  SELECT id, amount, status, deposit_purpose, purpose_audit
    INTO v_dep
  FROM public.deposit_requests
  WHERE id = p_deposit_request_id
  FOR UPDATE;

  IF v_dep.id IS NULL THEN
    RAISE EXCEPTION 'deposit_request_not_found';
  END IF;

  v_prev := COALESCE(v_dep.purpose_audit->>'cash_location', 'cash_at_hand');
  v_seq  := COALESCE(NULLIF(v_dep.purpose_audit->>'treasury_seq','')::int, 0);
  v_ref  := 'DEP-' || left(p_deposit_request_id::text, 8);

  IF v_loc = 'bank' THEN
    IF v_dep.status <> 'approved' THEN
      RAISE EXCEPTION 'deposit_not_verified';
    END IF;
    IF COALESCE(v_dep.amount, 0) <= 0 THEN
      RAISE EXCEPTION 'invalid_deposit_amount';
    END IF;
  END IF;

  -- Does an A5 (cash-in-transit) debit already exist for this deposit?
  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE source_table = 'deposit_requests'
      AND source_id = p_deposit_request_id
      AND category = 'cash_receipt_in_transit'
      AND direction = 'cash_in'
  ) INTO v_has_transit;

  -- Did the APPROVAL actually debit A1 (Cash and Bank) for this deposit?
  -- Only then is a reclass out of A1 into A5 correct. Genuine cash receipts
  -- approved through the float path never debited A1 (their platform leg is an
  -- A1 CREDIT), so reclassing them wrongly reduced Money We Have twice.
  SELECT EXISTS (
    SELECT 1
    FROM public.general_ledger gl
    JOIN public.ledger_account_map m
      ON m.ledger_scope = gl.ledger_scope
     AND m.category     = gl.category
     AND m.wallet_bucket IS NULL
    WHERE gl.source_table = 'deposit_requests'
      AND gl.source_id = p_deposit_request_id
      AND gl.ledger_scope = 'platform'
      AND m.account_code = 'A1'
      AND gl.direction = m.debit_when
      AND gl.category <> 'treasury_bank_deposit'
      AND gl.classification IN ('production','legacy_real')
  ) INTO v_has_a1_debit;

  IF v_dep.status = 'approved' AND COALESCE(v_dep.amount, 0) > 0 AND NOT v_has_transit THEN
    IF v_has_a1_debit THEN
      -- 4a) LEGACY ONLY: the approval debited the cash straight into A1.
      --     Reclass it into Cash in Transit exactly once.
      v_group := public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object(
            'ledger_scope','platform','direction','cash_in',
            'category','cash_receipt_in_transit','amount', v_dep.amount,
            'account','platform:cash_in_transit',
            'description','Cash received by Financial Ops — held as cash in transit',
            'source_table','deposit_requests','source_id', p_deposit_request_id,
            'reference_id', v_ref, 'classification','production'
          ),
          jsonb_build_object(
            'ledger_scope','platform','direction','cash_out',
            'category','cash_at_bank_reclass','amount', v_dep.amount,
            'account','platform:cash_at_bank',
            'description','Reclass out of Cash and Bank pending physical banking',
            'source_table','deposit_requests','source_id', p_deposit_request_id,
            'reference_id', v_ref, 'classification','production'
          )
        ),
        'cash_receipt_transit:' || p_deposit_request_id::text
      );
      v_audit := v_audit || jsonb_build_object('cash_transit_group_id', v_group, 'cash_transit_legacy_reclass', true);
    ELSE
      -- 4a-bis) GENUINE CASH RECEIPT missing its A5 intake: post the correct
      --         intake pair (A5 debit / custody payable) and convert the wrong
      --         A1 credit into the float offset it should always have been.
      v_group := public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object(
            'ledger_scope','platform','direction','cash_in',
            'category','cash_receipt_in_transit','amount', v_dep.amount,
            'account','platform:cash_in_transit',
            'description','Cash received by Financial Ops — held as cash in transit',
            'source_table','deposit_requests','source_id', p_deposit_request_id,
            'reference_id', v_ref, 'classification','production'
          ),
          jsonb_build_object(
            'ledger_scope','platform','direction','cash_out',
            'category','cash_custody_payable','amount', v_dep.amount,
            'description','Custody obligation for physical cash received, not yet banked',
            'source_table','deposit_requests','source_id', p_deposit_request_id,
            'reference_id', v_ref, 'classification','production'
          ),
          jsonb_build_object(
            'ledger_scope','platform','direction','cash_in',
            'category','agent_float_deposit','amount', v_dep.amount,
            'description','Reverse: cash intake wrongly credited Cash and Bank as agent float',
            'source_table','deposit_requests','source_id', p_deposit_request_id,
            'reference_id', v_ref, 'classification','production'
          ),
          jsonb_build_object(
            'ledger_scope','platform','direction','cash_out',
            'category','agent_float_cash_offset','amount', v_dep.amount,
            'description','Offset: physical cash is held by the company, not with the agent',
            'source_table','deposit_requests','source_id', p_deposit_request_id,
            'reference_id', v_ref, 'classification','production'
          )
        ),
        'cash_receipt_intake_fix:' || p_deposit_request_id::text
      );
      v_audit := v_audit || jsonb_build_object('cash_transit_group_id', v_group, 'cash_receipt_intake_backfill', true);
    END IF;
  END IF;

  -- 4b) Bank the cash: Cash in Transit -> Treasury / Cash at Bank
  IF v_loc = 'bank' AND v_prev <> 'bank' THEN
    v_seq := v_seq + 1;
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_in',
          'category','treasury_bank_deposit','amount', v_dep.amount,
          'account','platform:cash_at_bank',
          'description','Treasury: cash deposit banked by Financial Ops',
          'source_table','deposit_requests','source_id', p_deposit_request_id,
          'reference_id', v_ref, 'classification','production'
        ),
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_out',
          'category','cash_in_transit_banked','amount', v_dep.amount,
          'account','platform:cash_in_transit',
          'description','Cash in transit released — banked to Treasury',
          'source_table','deposit_requests','source_id', p_deposit_request_id,
          'reference_id', v_ref, 'classification','production'
        )
      ),
      'treasury_bank_deposit:' || p_deposit_request_id::text || ':' || v_seq::text
    );
    v_audit := v_audit || jsonb_build_object('treasury_group_id', v_group, 'treasury_posted_at', now());

  -- 4c) Un-bank: exact reversal so Treasury is never overstated
  ELSIF v_loc = 'cash_at_hand' AND v_prev = 'bank' AND v_seq > 0
        AND COALESCE(v_dep.amount, 0) > 0 THEN
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_out',
          'category','treasury_bank_deposit','amount', v_dep.amount,
          'account','platform:cash_at_bank',
          'description','Treasury: banking reversed — cash returned to hand',
          'source_table','deposit_requests','source_id', p_deposit_request_id,
          'reference_id', v_ref, 'classification','production'
        ),
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_in',
          'category','cash_in_transit_banked','amount', v_dep.amount,
          'account','platform:cash_in_transit',
          'description','Cash back in transit — banking reversed',
          'source_table','deposit_requests','source_id', p_deposit_request_id,
          'reference_id', v_ref, 'classification','production'
        )
      ),
      'treasury_bank_reversal:' || p_deposit_request_id::text || ':' || v_seq::text
    );
    v_audit := v_audit || jsonb_build_object('treasury_reversal_group_id', v_group, 'treasury_reversed_at', now());
  END IF;

  UPDATE public.deposit_requests
  SET purpose_audit = COALESCE(purpose_audit, '{}'::jsonb)
    || jsonb_build_object(
         'cash_location', v_loc,
         'cash_location_changed_at', now(),
         'cash_location_changed_by', auth.uid(),
         'cash_location_previous', v_prev,
         'cash_location_note', p_note,
         'treasury_seq', v_seq
       )
    || v_audit,
    updated_at = now()
  WHERE id = p_deposit_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (
    auth.uid(),
    'cash_location_changed',
    'deposit_requests',
    p_deposit_request_id::text,
    'cash_location_changed',
    jsonb_build_object(
      'cash_location', v_loc,
      'previous', v_prev,
      'amount', v_dep.amount,
      'treasury_seq', v_seq,
      'ledger', v_audit,
      'reason', COALESCE(NULLIF(p_note, ''), 'Cash location updated to ' || v_loc || ' by finance staff')
    )
  );

  RETURN v_loc;
END;
$function$;

-- ── One-off correction of the three affected receipt-path cash deposits ──
-- Each had (a) a platform agent_float_deposit cash_out leg wrongly CREDITING A1
-- and (b) a legacy bank reclass that fired on a genuine cash receipt, so each
-- deposit reduced Money We Have by its amount instead of increasing it.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT dr.id, dr.amount, 'DEP-' || left(dr.id::text, 8) AS ref
    FROM public.deposit_requests dr
    WHERE dr.id IN (
      'be1c4ac5-97a0-4798-a97f-b94a08fb5ca1',
      '9af9b133-1a8a-4ef6-8517-b319e921af25',
      'd70ba084-b4d3-4927-b8c4-d0c77080a208'
    )
  LOOP
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        -- reverse the incorrect legacy bank reclass pair
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_in',
          'category','cash_at_bank_reclass','amount', r.amount,
          'account','platform:cash_at_bank',
          'description','Reverse: bank reclass fired incorrectly on a genuine cash receipt',
          'source_table','deposit_requests','source_id', r.id,
          'reference_id', r.ref, 'classification','production'
        ),
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_out',
          'category','cash_receipt_in_transit','amount', r.amount,
          'account','platform:cash_in_transit',
          'description','Reverse: cash-in-transit debit raised by the incorrect reclass',
          'source_table','deposit_requests','source_id', r.id,
          'reference_id', r.ref, 'classification','production'
        ),
        -- correct cash intake pair
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_in',
          'category','cash_receipt_in_transit','amount', r.amount,
          'account','platform:cash_in_transit',
          'description','Cash received by Financial Ops — held as cash in transit',
          'source_table','deposit_requests','source_id', r.id,
          'reference_id', r.ref, 'classification','production'
        ),
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_out',
          'category','cash_custody_payable','amount', r.amount,
          'description','Custody obligation for physical cash received, not yet banked',
          'source_table','deposit_requests','source_id', r.id,
          'reference_id', r.ref, 'classification','production'
        ),
        -- convert the wrong A1 credit into the float offset
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_in',
          'category','agent_float_deposit','amount', r.amount,
          'description','Reverse: cash intake wrongly credited Cash and Bank as agent float',
          'source_table','deposit_requests','source_id', r.id,
          'reference_id', r.ref, 'classification','production'
        ),
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_out',
          'category','agent_float_cash_offset','amount', r.amount,
          'description','Offset: physical cash is held by the company, not with the agent',
          'source_table','deposit_requests','source_id', r.id,
          'reference_id', r.ref, 'classification','production'
        )
      ),
      'cash_receipt_classification_fix:' || r.id::text
    );
  END LOOP;
END;
$$;