-- Add column to track first transaction bonus
ALTER TABLE public.referrals 
ADD COLUMN IF NOT EXISTS first_transaction_bonus_credited BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS first_transaction_bonus_credited_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS first_transaction_bonus_amount NUMERIC DEFAULT 200;

-- Create function to credit first transaction bonus
CREATE OR REPLACE FUNCTION public.credit_first_transaction_bonus()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  referral_record RECORD;
  bonus_amount NUMERIC := 200;
  user_id_to_check UUID;
BEGIN
  -- Determine the user ID based on which table triggered this
  IF TG_TABLE_NAME = 'wallet_transactions' THEN
    user_id_to_check := NEW.sender_id;
  ELSIF TG_TABLE_NAME = 'repayments' THEN
    user_id_to_check := NEW.tenant_id;
  ELSIF TG_TABLE_NAME = 'wallet_deposits' THEN
    user_id_to_check := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'product_orders' THEN
    user_id_to_check := NEW.buyer_id;
  ELSIF TG_TABLE_NAME = 'user_loan_repayments' THEN
    user_id_to_check := NEW.borrower_id;
  ELSE
    RETURN NEW;
  END IF;

  -- Find the referral record where this user was referred and bonus not yet credited
  SELECT * INTO referral_record
  FROM public.referrals
  WHERE referred_id = user_id_to_check
    AND first_transaction_bonus_credited = false
  LIMIT 1;

  -- If found, credit the referrer
  IF referral_record IS NOT NULL THEN
    -- Update referral record
    UPDATE public.referrals
    SET first_transaction_bonus_credited = true,
        first_transaction_bonus_credited_at = now(),
        first_transaction_bonus_amount = bonus_amount
    WHERE id = referral_record.id;

    -- Credit referrer's wallet
    UPDATE public.wallets
    SET balance = balance + bonus_amount,
        updated_at = now()
    WHERE user_id = referral_record.referrer_id;

    -- Create earnings record if referrer is an agent
    IF has_role(referral_record.referrer_id, 'agent'::app_role) THEN
      INSERT INTO public.agent_earnings (agent_id, amount, earning_type, source_user_id, description)
      VALUES (referral_record.referrer_id, bonus_amount, 'referral_first_transaction', user_id_to_check, 'First transaction bonus from referred user');
    END IF;

    -- Send notification to referrer
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      referral_record.referrer_id,
      '🎁 First Transaction Bonus!',
      'Your referred friend just made their first transaction! You earned an extra UGX ' || bonus_amount || '!',
      'success',
      jsonb_build_object(
        'referred_user_id', user_id_to_check, 
        'bonus_amount', bonus_amount,
        'bonus_type', 'first_transaction'
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Create triggers on relevant transaction tables
DROP TRIGGER IF EXISTS on_wallet_transaction_first_bonus ON public.wallet_transactions;
CREATE TRIGGER on_wallet_transaction_first_bonus
  AFTER INSERT ON public.wallet_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.credit_first_transaction_bonus();

DROP TRIGGER IF EXISTS on_repayment_first_bonus ON public.repayments;
CREATE TRIGGER on_repayment_first_bonus
  AFTER INSERT ON public.repayments
  FOR EACH ROW
  EXECUTE FUNCTION public.credit_first_transaction_bonus();

DROP TRIGGER IF EXISTS on_deposit_first_bonus ON public.wallet_deposits;
CREATE TRIGGER on_deposit_first_bonus
  AFTER INSERT ON public.wallet_deposits
  FOR EACH ROW
  EXECUTE FUNCTION public.credit_first_transaction_bonus();

DROP TRIGGER IF EXISTS on_product_order_first_bonus ON public.product_orders;
CREATE TRIGGER on_product_order_first_bonus
  AFTER INSERT ON public.product_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.credit_first_transaction_bonus();

DROP TRIGGER IF EXISTS on_loan_repayment_first_bonus ON public.user_loan_repayments;
CREATE TRIGGER on_loan_repayment_first_bonus
  AFTER INSERT ON public.user_loan_repayments
  FOR EACH ROW
  EXECUTE FUNCTION public.credit_first_transaction_bonus();