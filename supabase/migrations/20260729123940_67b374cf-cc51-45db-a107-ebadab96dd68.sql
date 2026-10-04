
DO $$
DECLARE
  v_rr uuid := 'd723bc4d-c905-482d-b4a1-176c8ce78a7c';
  v_denis uuid := 'a5fdeba7-13ef-48e9-b93a-a82b8d02807f';
  v_ian uuid := '3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0';
  v_landlord uuid;
  v_tenant uuid;
  v_now timestamptz := now();
BEGIN
  SELECT landlord_id, tenant_id INTO v_landlord, v_tenant
  FROM rent_requests WHERE id = v_rr;

  -- 1) Reverse 3 duplicate float credits (UGX 12,000,000 total)
  --    Original: platform cash_out rent_disbursement + bridge cash_in rent_receivable_created
  --    Reversal: platform cash_in system_balance_correction + bridge cash_out system_balance_correction
  PERFORM create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'direction','cash_in','amount',12000000,'category','system_balance_correction',
        'ledger_scope','platform','source_table','rent_requests','source_id',v_rr,
        'description','Reverse 3 duplicate landlord-float credits on RR d723bc4d (Denis, 2026-07-29 duplicate clicks)',
        'currency','UGX','user_id',v_denis,'linked_party',v_landlord,
        'classification','admin_correction','transaction_date',v_now
      ),
      jsonb_build_object(
        'direction','cash_out','amount',12000000,'category','system_balance_correction',
        'ledger_scope','bridge','source_table','rent_requests','source_id',v_rr,
        'description','Reverse 3 duplicate rent_receivable_created on RR d723bc4d',
        'currency','UGX','user_id',v_denis,'linked_party',v_landlord,
        'classification','admin_correction','transaction_date',v_now
      )
    )
  );

  -- 2) Reverse 3 duplicate wallet bonuses (UGX 15,000 total) — debits Denis withdrawable
  PERFORM create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'direction','cash_out','amount',15000,'category','system_balance_correction',
        'ledger_scope','wallet','source_table','rent_requests','source_id',v_rr,
        'description','Reverse 3 duplicate rent-funded bonuses on RR d723bc4d (Denis)',
        'currency','UGX','user_id',v_denis,'linked_party',v_tenant,
        'recipient_type','user',
        'classification','admin_correction','transaction_date',v_now,
        'solvency_bypass_reason','duplicate_reversal'
      ),
      jsonb_build_object(
        'direction','cash_in','amount',15000,'category','system_balance_correction',
        'ledger_scope','platform','source_table','rent_requests','source_id',v_rr,
        'description','Reverse 3 duplicate rent-funded bonus platform expenses on RR d723bc4d',
        'currency','UGX','user_id',v_denis,
        'classification','admin_correction','transaction_date',v_now
      )
    )
  );

  -- 3) Adjust agent_landlord_float cache for Denis
  UPDATE agent_landlord_float
     SET balance = balance - 12000000,
         total_funded = total_funded - 12000000,
         updated_at = v_now
   WHERE agent_id = v_denis;

  -- 4) Delete 3 duplicate agent_float_funding rows (keep earliest 11:36:03 row)
  DELETE FROM agent_float_funding
   WHERE id IN (
     '0c0a040c-2623-4918-8038-7fa209ac6453',
     '31bd73f4-eb8f-4572-be88-0cca8fbae56f',
     '86f2e7d7-d8d3-48d3-aabc-52bbc25ab30a'
   );

  -- 5) Reset assigned_agent_id back to listing agent Ian Martin
  UPDATE rent_requests
     SET assigned_agent_id = v_ian,
         updated_at = v_now
   WHERE id = v_rr;

  -- 6) Audit log
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_denis,
    'duplicate_funding_reversal',
    'rent_requests',
    v_rr,
    jsonb_build_object(
      'rent_request_id', v_rr,
      'agent_id', v_denis,
      'reversed_float_amount', 12000000,
      'reversed_bonus_amount', 15000,
      'duplicate_funding_events', 3,
      'assigned_agent_reset_to', v_ian,
      'previous_assigned_agent', v_denis,
      'reason', 'reverse_duplicate_funding_rr_d723bc4d'
    )
  );
END $$;
