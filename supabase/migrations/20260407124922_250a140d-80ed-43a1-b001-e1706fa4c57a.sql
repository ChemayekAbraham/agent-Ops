
-- Backfill missing proxy approval credits using the same function logic
DO $$
DECLARE
  r RECORD;
  v_tx_uuid UUID;
  v_desc TEXT;
BEGIN
  FOR r IN
    SELECT pa.id as assignment_id, pa.beneficiary_id, p.full_name as ben_name, pa.agent_id,
           ip.id as portfolio_id, ip.investment_amount, ip.portfolio_code,
           ap.full_name as agent_name
    FROM proxy_agent_assignments pa
    JOIN profiles p ON p.id = pa.beneficiary_id
    JOIN profiles ap ON ap.id = pa.agent_id
    JOIN investor_portfolios ip ON ip.investor_id = pa.beneficiary_id AND ip.status = 'active'
    WHERE pa.approval_status = 'approved' AND pa.is_active = true
    AND (SELECT COUNT(*) FROM general_ledger gl WHERE gl.user_id = pa.agent_id AND gl.linked_party = pa.beneficiary_id::text AND gl.category = 'roi_payout') = 0
    AND ip.investment_amount > 0
  LOOP
    v_tx_uuid := md5('proxy-approval-' || r.assignment_id || '-' || r.portfolio_id)::uuid;
    
    -- Skip if already exists
    IF EXISTS (SELECT 1 FROM general_ledger WHERE transaction_group_id = v_tx_uuid) THEN
      CONTINUE;
    END IF;
    
    v_desc := '[Managed Payout] [Agent Wallet] Proxy approval credit (backfill) of USh ' || r.investment_amount || ' to ' || r.agent_name || '''s agent wallet on behalf of ' || r.ben_name || '. Portfolio: ' || r.portfolio_code || '. — on behalf of partner ' || r.beneficiary_id;
    
    INSERT INTO general_ledger (
      user_id, amount, direction, category, description,
      currency, transaction_group_id, source_table, source_id,
      ledger_scope, linked_party
    ) VALUES (
      r.agent_id, r.investment_amount, 'cash_in', 'roi_payout', v_desc,
      'UGX', v_tx_uuid, 'investor_portfolios', r.portfolio_id,
      'wallet', r.beneficiary_id::text
    );
  END LOOP;
END;
$$;
