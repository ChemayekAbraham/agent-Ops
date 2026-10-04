
-- Add triggers for ALL remaining financial tables into general_ledger

-- 1. wallet_deposits (cash_in)
CREATE OR REPLACE FUNCTION public.log_wallet_deposit_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id
  ) VALUES (
    NEW.created_at,
    NEW.amount,
    'cash_in',
    'wallet_deposit',
    'Wallet deposit',
    NEW.user_id,
    'wallet_deposits',
    NEW.id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_wallet_deposit_to_ledger
AFTER INSERT ON public.wallet_deposits
FOR EACH ROW
EXECUTE FUNCTION public.log_wallet_deposit_to_ledger();

-- 2. wallet_withdrawals (cash_out)
CREATE OR REPLACE FUNCTION public.log_wallet_withdrawal_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id
  ) VALUES (
    NEW.created_at,
    NEW.amount,
    'cash_out',
    'wallet_withdrawal',
    'Wallet withdrawal',
    NEW.user_id,
    'wallet_withdrawals',
    NEW.id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_wallet_withdrawal_to_ledger
AFTER INSERT ON public.wallet_withdrawals
FOR EACH ROW
EXECUTE FUNCTION public.log_wallet_withdrawal_to_ledger();

-- 3. wallet_transactions / transfers (both sides)
CREATE OR REPLACE FUNCTION public.log_wallet_transfer_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  -- Sender side (cash_out)
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, linked_party, source_table, source_id
  ) VALUES (
    NEW.created_at,
    NEW.amount,
    'cash_out',
    'wallet_transfer',
    COALESCE(NEW.description, 'Transfer sent'),
    NEW.sender_id,
    'Recipient',
    'wallet_transactions',
    NEW.id
  );
  -- Recipient side (cash_in)
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, linked_party, source_table, source_id
  ) VALUES (
    NEW.created_at,
    NEW.amount,
    'cash_in',
    'wallet_transfer',
    COALESCE(NEW.description, 'Transfer received'),
    NEW.recipient_id,
    'Sender',
    'wallet_transactions',
    NEW.id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_wallet_transfer_to_ledger
AFTER INSERT ON public.wallet_transactions
FOR EACH ROW
EXECUTE FUNCTION public.log_wallet_transfer_to_ledger();

-- 4. repayments (cash_in for platform)
CREATE OR REPLACE FUNCTION public.log_repayment_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, reference_id, source_table, source_id
  ) VALUES (
    NEW.created_at,
    NEW.amount,
    'cash_in',
    'rent_repayment',
    'Rent repayment',
    NEW.user_id,
    NEW.transaction_id,
    'repayments',
    NEW.id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_repayment_to_ledger
AFTER INSERT ON public.repayments
FOR EACH ROW
EXECUTE FUNCTION public.log_repayment_to_ledger();

-- 5. landlord_payment_proofs (cash_out when verified)
CREATE OR REPLACE FUNCTION public.log_landlord_payment_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'verified' AND (OLD.status IS NULL OR OLD.status != 'verified') THEN
    INSERT INTO public.general_ledger (
      transaction_date, amount, direction, category, description,
      user_id, reference_id, source_table, source_id
    ) VALUES (
      COALESCE(NEW.verified_at, now()),
      NEW.amount,
      'cash_out',
      'landlord_payout',
      'Landlord rent payment',
      NEW.supporter_id,
      NEW.transaction_id,
      'landlord_payment_proofs',
      NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_landlord_payment_to_ledger
AFTER INSERT OR UPDATE ON public.landlord_payment_proofs
FOR EACH ROW
EXECUTE FUNCTION public.log_landlord_payment_to_ledger();

-- 6. investment_transactions
CREATE OR REPLACE FUNCTION public.log_investment_tx_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id
  ) VALUES (
    NEW.transaction_date,
    NEW.amount,
    CASE WHEN NEW.transaction_type IN ('deposit', 'top_up', 'initial', 'roi_payout') THEN 'cash_in' ELSE 'cash_out' END,
    'investment_' || NEW.transaction_type,
    COALESCE(NEW.description, 'Investment ' || NEW.transaction_type),
    NEW.user_id,
    'investment_transactions',
    NEW.id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_investment_tx_to_ledger
AFTER INSERT ON public.investment_transactions
FOR EACH ROW
EXECUTE FUNCTION public.log_investment_tx_to_ledger();

-- 7. agent_commission_payouts (cash_out when processed)
CREATE OR REPLACE FUNCTION public.log_agent_payout_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'processed' AND (OLD.status IS NULL OR OLD.status != 'processed') THEN
    INSERT INTO public.general_ledger (
      transaction_date, amount, direction, category, description,
      user_id, reference_id, source_table, source_id
    ) VALUES (
      COALESCE(NEW.processed_at, now()),
      NEW.amount,
      'cash_out',
      'agent_payout',
      'Agent commission payout',
      NEW.agent_id,
      NEW.transaction_id,
      'agent_commission_payouts',
      NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_agent_payout_to_ledger
AFTER INSERT OR UPDATE ON public.agent_commission_payouts
FOR EACH ROW
EXECUTE FUNCTION public.log_agent_payout_to_ledger();

-- 8. landlord_payout_requests (cash_out when paid)
CREATE OR REPLACE FUNCTION public.log_landlord_payout_request_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'paid' AND (OLD.status IS NULL OR OLD.status != 'paid') THEN
    INSERT INTO public.general_ledger (
      transaction_date, amount, direction, category, description,
      user_id, reference_id, linked_party, source_table, source_id
    ) VALUES (
      COALESCE(NEW.paid_at, now()),
      NEW.amount,
      'cash_out',
      'landlord_payout_request',
      'Landlord payout to ' || NEW.property_address,
      NEW.agent_id,
      NEW.transaction_id,
      'Landlord',
      'landlord_payout_requests',
      NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_landlord_payout_request_to_ledger
AFTER INSERT OR UPDATE ON public.landlord_payout_requests
FOR EACH ROW
EXECUTE FUNCTION public.log_landlord_payout_request_to_ledger();

-- 9. user_loan_repayments (cash_in)
CREATE OR REPLACE FUNCTION public.log_loan_repayment_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id
  ) VALUES (
    NEW.paid_at,
    NEW.amount,
    'cash_in',
    'loan_repayment',
    'Loan repayment',
    NEW.borrower_id,
    'user_loan_repayments',
    NEW.id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_loan_repayment_to_ledger
AFTER INSERT ON public.user_loan_repayments
FOR EACH ROW
EXECUTE FUNCTION public.log_loan_repayment_to_ledger();
