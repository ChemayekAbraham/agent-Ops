-- ROLLBACK of 20261118090100_special_advance_wallet_payment_sms: stops the SMS; payments are unaffected.
DROP TRIGGER IF EXISTS special_advance_repayments_sms_wallet ON public.special_advance_repayments;
DROP FUNCTION IF EXISTS public._special_advance_sms_wallet_repayment();
