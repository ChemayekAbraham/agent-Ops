
CREATE OR REPLACE FUNCTION public.set_wallet_bucket_from_recipient_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only stamp wallet-scope legs where bucket wasn't explicitly provided
  IF NEW.ledger_scope = 'wallet' AND NEW.wallet_bucket IS NULL THEN
    IF NEW.recipient_type = 'user' THEN
      NEW.wallet_bucket := 'withdrawable';
    ELSIF NEW.recipient_type = 'operational_wallet' THEN
      NEW.wallet_bucket := 'float';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_wallet_bucket_from_recipient_type ON public.general_ledger;
CREATE TRIGGER trg_set_wallet_bucket_from_recipient_type
BEFORE INSERT ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.set_wallet_bucket_from_recipient_type();
