
-- Replace ALL triggers that insert into general_ledger to instead insert into pending_wallet_operations
-- The approve-wallet-operation edge function will move approved entries to general_ledger

-- 1. wallet_deposits (cash_in)
CREATE OR REPLACE FUNCTION public.log_wallet_deposit_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.pending_wallet_operations (
    amount, direction, category, description,
    user_id, source_table, source_id, status
  ) VALUES (
    NEW.amount,
    'cash_in',
    'wallet_deposit',
    'Wallet deposit',
    NEW.user_id,
    'wallet_deposits',
    NEW.id,
    'pending'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. wallet_withdrawals (cash_out)
CREATE OR REPLACE FUNCTION public.log_wallet_withdrawal_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.pending_wallet_operations (
    amount, direction, category, description,
    user_id, source_table, source_id, status
  ) VALUES (
    NEW.amount,
    'cash_out',
    'wallet_withdrawal',
    'Wallet withdrawal',
    NEW.user_id,
    'wallet_withdrawals',
    NEW.id,
    'pending'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. wallet_transactions / transfers (both sides)
CREATE OR REPLACE FUNCTION public.log_wallet_transfer_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  -- Sender side (cash_out)
  INSERT INTO public.pending_wallet_operations (
    amount, direction, category, description,
    user_id, linked_party, source_table, source_id, status
  ) VALUES (
    NEW.amount,
    'cash_out',
    'wallet_transfer',
    COALESCE(NEW.description, 'Transfer sent'),
    NEW.sender_id,
    'Recipient',
    'wallet_transactions',
    NEW.id,
    'pending'
  );
  -- Recipient side (cash_in)
  INSERT INTO public.pending_wallet_operations (
    amount, direction, category, description,
    user_id, linked_party, source_table, source_id, status
  ) VALUES (
    NEW.amount,
    'cash_in',
    'wallet_transfer',
    COALESCE(NEW.description, 'Transfer received'),
    NEW.recipient_id,
    'Sender',
    'wallet_transactions',
    NEW.id,
    'pending'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. repayments (cash_in)
CREATE OR REPLACE FUNCTION public.log_repayment_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.pending_wallet_operations (
    amount, direction, category, description,
    user_id, reference_id, source_table, source_id, status
  ) VALUES (
    NEW.amount,
    'cash_in',
    'rent_repayment',
    'Rent repayment',
    NEW.user_id,
    NEW.transaction_id,
    'repayments',
    NEW.id,
    'pending'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 5. landlord_payment_proofs (cash_out when verified)
CREATE OR REPLACE FUNCTION public.log_landlord_payment_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'verified' AND (OLD.status IS NULL OR OLD.status != 'verified') THEN
    INSERT INTO public.pending_wallet_operations (
      amount, direction, category, description,
      user_id, reference_id, source_table, source_id, status
    ) VALUES (
      NEW.amount,
      'cash_out',
      'landlord_payout',
      'Landlord rent payment',
      NEW.supporter_id,
      NEW.transaction_id,
      'landlord_payment_proofs',
      NEW.id,
      'pending'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 6. investment_transactions
CREATE OR REPLACE FUNCTION public.log_investment_tx_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.pending_wallet_operations (
    amount, direction, category, description,
    user_id, source_table, source_id, status
  ) VALUES (
    NEW.amount,
    CASE WHEN NEW.transaction_type IN ('deposit', 'top_up', 'initial', 'roi_payout') THEN 'cash_in' ELSE 'cash_out' END,
    'investment_' || NEW.transaction_type,
    COALESCE(NEW.description, 'Investment ' || NEW.transaction_type),
    NEW.user_id,
    'investment_transactions',
    NEW.id,
    'pending'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 7. agent_commission_payouts (cash_out when processed)
CREATE OR REPLACE FUNCTION public.log_agent_payout_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'processed' AND (OLD.status IS NULL OR OLD.status != 'processed') THEN
    INSERT INTO public.pending_wallet_operations (
      amount, direction, category, description,
      user_id, reference_id, source_table, source_id, status
    ) VALUES (
      NEW.amount,
      'cash_out',
      'agent_payout',
      'Agent commission payout',
      NEW.agent_id,
      NEW.transaction_id,
      'agent_commission_payouts',
      NEW.id,
      'pending'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 8. landlord_payout_requests (cash_out when paid)
CREATE OR REPLACE FUNCTION public.log_landlord_payout_request_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'paid' AND (OLD.status IS NULL OR OLD.status != 'paid') THEN
    INSERT INTO public.pending_wallet_operations (
      amount, direction, category, description,
      user_id, reference_id, linked_party, source_table, source_id, status
    ) VALUES (
      NEW.amount,
      'cash_out',
      'landlord_payout_request',
      'Landlord payout to ' || NEW.property_address,
      NEW.agent_id,
      NEW.transaction_id,
      'Landlord',
      'landlord_payout_requests',
      NEW.id,
      'pending'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 9. user_loan_repayments (cash_in)
CREATE OR REPLACE FUNCTION public.log_loan_repayment_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.pending_wallet_operations (
    amount, direction, category, description,
    user_id, source_table, source_id, status
  ) VALUES (
    NEW.amount,
    'cash_in',
    'loan_repayment',
    'Loan repayment',
    NEW.borrower_id,
    'user_loan_repayments',
    NEW.id,
    'pending'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
