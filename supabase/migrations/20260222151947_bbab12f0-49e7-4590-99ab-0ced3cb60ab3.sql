
-- Fix: Re-create the agent commission trigger and update the function to use the ledger system

CREATE OR REPLACE FUNCTION public.credit_agent_repayment_commission()
RETURNS TRIGGER AS $$
DECLARE
  tenant_agent_id UUID;
  parent_agent_id_val UUID;
  commission_rate NUMERIC;
  parent_commission_rate NUMERIC := 0.01;
  sub_agent_commission_rate NUMERIC := 0.04;
  regular_agent_commission_rate NUMERIC := 0.05;
  commission_amount NUMERIC;
  parent_commission_amount NUMERIC;
  is_sub_agent BOOLEAN := FALSE;
  tx_group UUID;
BEGIN
  -- Find the agent tagged to this tenant's rent request
  SELECT agent_id INTO tenant_agent_id
  FROM rent_requests
  WHERE id = NEW.rent_request_id;

  -- Fallback: check referrals
  IF tenant_agent_id IS NULL THEN
    SELECT referrer_id INTO tenant_agent_id
    FROM referrals
    WHERE referred_id = NEW.tenant_id
    LIMIT 1;
  END IF;

  IF tenant_agent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if sub-agent
  SELECT sa.parent_agent_id INTO parent_agent_id_val
  FROM agent_subagents sa
  WHERE sa.sub_agent_id = tenant_agent_id;

  IF parent_agent_id_val IS NOT NULL THEN
    is_sub_agent := TRUE;
    commission_rate := sub_agent_commission_rate;
  ELSE
    commission_rate := regular_agent_commission_rate;
  END IF;

  commission_amount := ROUND(NEW.amount * commission_rate);

  -- Record in agent_earnings
  INSERT INTO agent_earnings (agent_id, amount, earning_type, description, source_user_id, rent_request_id)
  VALUES (
    tenant_agent_id,
    commission_amount,
    'commission',
    CASE WHEN is_sub_agent
      THEN '4% commission on rent repayment of UGX ' || NEW.amount::TEXT
      ELSE '5% commission on rent repayment of UGX ' || NEW.amount::TEXT
    END,
    NEW.tenant_id,
    NEW.rent_request_id
  );

  -- Queue commission via ledger (pending_wallet_operations)
  tx_group := gen_random_uuid();
  INSERT INTO pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, transaction_group_id, description, linked_party, status)
  VALUES (
    tenant_agent_id,
    commission_amount,
    'cash_in',
    'agent_commission_payout',
    'repayments',
    NEW.id,
    tx_group,
    CASE WHEN is_sub_agent
      THEN '4% commission on tenant rent repayment'
      ELSE '5% commission on tenant rent repayment'
    END,
    'platform',
    'pending'
  );

  -- If sub-agent, also credit parent agent 1%
  IF is_sub_agent AND parent_agent_id_val IS NOT NULL THEN
    parent_commission_amount := ROUND(NEW.amount * parent_commission_rate);

    INSERT INTO agent_earnings (agent_id, amount, earning_type, description, source_user_id, rent_request_id)
    VALUES (
      parent_agent_id_val,
      parent_commission_amount,
      'subagent_commission',
      '1% override commission from sub-agent tenant repayment of UGX ' || NEW.amount::TEXT,
      NEW.tenant_id,
      NEW.rent_request_id
    );

    INSERT INTO pending_wallet_operations (user_id, amount, direction, category, source_table, source_id, transaction_group_id, description, linked_party, status)
    VALUES (
      parent_agent_id_val,
      parent_commission_amount,
      'cash_in',
      'agent_commission_payout',
      'repayments',
      NEW.id,
      gen_random_uuid(),
      '1% override from sub-agent tenant repayment',
      'platform',
      'pending'
    );
  END IF;

  -- Send notification to agent
  INSERT INTO notifications (user_id, title, message, type)
  VALUES (
    tenant_agent_id,
    'Commission Earned! 💰',
    'You earned UGX ' || commission_amount::TEXT || ' (' || (commission_rate * 100)::TEXT || '%) from a tenant rent repayment.',
    'earning'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Re-create the trigger
DROP TRIGGER IF EXISTS on_repayment_agent_commission ON repayments;
CREATE TRIGGER on_repayment_agent_commission
AFTER INSERT ON repayments
FOR EACH ROW
EXECUTE FUNCTION credit_agent_repayment_commission();
