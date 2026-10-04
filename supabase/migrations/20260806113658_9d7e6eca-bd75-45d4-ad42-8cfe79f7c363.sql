CREATE OR REPLACE FUNCTION public.enforce_merchant_payout_authorization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.dispatch_claimed_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.dispatch_claimed_by IS DISTINCT FROM OLD.dispatch_claimed_by) THEN
    IF NOT public.merchant_agent_allows_withdrawal(
          NEW.dispatch_claimed_by, NEW.reason, NEW.payout_method, NEW.bank_name, NEW.mobile_money_provider) THEN
      RAISE EXCEPTION 'This payout is outside your authorized payment channels / payout categories';
    END IF;
  END IF;

  IF NEW.assigned_cashout_agent_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assigned_cashout_agent_id IS DISTINCT FROM OLD.assigned_cashout_agent_id) THEN
    IF NOT public.merchant_agent_allows_withdrawal(
          NEW.assigned_cashout_agent_id, NEW.reason, NEW.payout_method, NEW.bank_name, NEW.mobile_money_provider) THEN
      RAISE EXCEPTION 'Merchant agent is not authorized for this payment channel / payout category';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $do$
DECLARE i int := 0;
BEGIN
  LOOP
    i := i + 1;
    BEGIN
      SET LOCAL lock_timeout = '4s';
      DROP TRIGGER IF EXISTS trg_enforce_merchant_payout_authorization ON public.withdrawal_requests;
      CREATE TRIGGER trg_enforce_merchant_payout_authorization
      BEFORE INSERT OR UPDATE ON public.withdrawal_requests
      FOR EACH ROW EXECUTE FUNCTION public.enforce_merchant_payout_authorization();
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF i >= 6 THEN RAISE; END IF;
      PERFORM pg_sleep(2);
    END;
  END LOOP;
END
$do$;