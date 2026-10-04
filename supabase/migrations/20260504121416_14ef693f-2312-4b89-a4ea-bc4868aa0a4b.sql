CREATE TABLE IF NOT EXISTS public.withdrawal_attempt_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  attempted_amount numeric NOT NULL,
  ledger_available numeric NOT NULL,
  reason text NOT NULL,
  client_request_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_attempt_failures_user
  ON public.withdrawal_attempt_failures (user_id, created_at DESC);

ALTER TABLE public.withdrawal_attempt_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own failed attempts"
  ON public.withdrawal_attempt_failures;
CREATE POLICY "Users see own failed attempts"
  ON public.withdrawal_attempt_failures
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Ops see all failed attempts"
  ON public.withdrawal_attempt_failures;
CREATE POLICY "Ops see all failed attempts"
  ON public.withdrawal_attempt_failures
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'super_admin')
  );

CREATE OR REPLACE FUNCTION public.enforce_withdrawal_ledger_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available numeric;
BEGIN
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    INSERT INTO public.withdrawal_attempt_failures (
      user_id, attempted_amount, ledger_available, reason, client_request_id
    ) VALUES (
      NEW.user_id, COALESCE(NEW.amount, 0), 0,
      'INVALID_AMOUNT', NEW.client_request_id
    );
    RAISE EXCEPTION 'Invalid withdrawal amount'
      USING ERRCODE = '22023';
  END IF;

  SELECT public.get_user_available_balance(NEW.user_id) INTO v_available;
  v_available := COALESCE(v_available, 0);

  IF NEW.amount > v_available THEN
    INSERT INTO public.withdrawal_attempt_failures (
      user_id, attempted_amount, ledger_available, reason, client_request_id,
      metadata
    ) VALUES (
      NEW.user_id, NEW.amount, v_available,
      'LEDGER_MISMATCH', NEW.client_request_id,
      jsonb_build_object(
        'mobile_money_provider', NEW.mobile_money_provider,
        'mobile_money_number', NEW.mobile_money_number
      )
    );
    RAISE EXCEPTION
      'Ledger mismatch detected. Available: %, requested: %. Transaction aborted.',
      v_available, NEW.amount
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_withdrawal_ledger_match
  ON public.withdrawal_requests;
CREATE TRIGGER trg_enforce_withdrawal_ledger_match
  BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_withdrawal_ledger_match();