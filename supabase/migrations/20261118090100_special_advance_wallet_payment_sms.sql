-- Special Advances: SMS to the borrower after a Pay from Wallet repayment (CFO, 12 Nov 2026).
-- Requires 20261118090000_special_advance_pay_from_wallet. Notification only: posts nothing, moves no money.
--
-- A wallet repayment row queues one call to the edge function notify-special-advance-payment with the repayment id.
-- pg_net sends queued calls only after the transaction commits, so a payment that fails or rolls back never texts.
-- Any error queuing the call is swallowed: the SMS can never block or undo a payment.
-- Merchant Line repayments (recorded by the CFO) are not texted by this trigger.
-- Same mechanism and vault key as trg_sms_advance_deduction (sms_advance_deduction_on_ledger).
-- Rollback: supabase/rollbacks/20261118090100_special_advance_wallet_payment_sms.rollback.sql

DO $pre$
BEGIN
  IF to_regprocedure('public.special_advance_pay_from_wallet(uuid,bigint,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: apply 20261118090000_special_advance_pay_from_wallet first';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public._special_advance_sms_wallet_repayment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM net.http_post(
      url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/notify-special-advance-payment',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || COALESCE(
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1), '')),
      body := jsonb_build_object('repayment_id', NEW.id)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- a text that cannot be queued never affects the payment
  END;
  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION public._special_advance_sms_wallet_repayment() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER special_advance_repayments_sms_wallet
  AFTER INSERT ON public.special_advance_repayments
  FOR EACH ROW WHEN (NEW.method = 'wallet')
  EXECUTE FUNCTION public._special_advance_sms_wallet_repayment();
