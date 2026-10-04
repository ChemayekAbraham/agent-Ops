
-- Payroll Growth Balances tracker
CREATE TABLE IF NOT EXISTS public.payroll_growth_balances (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  original_amount NUMERIC NOT NULL CHECK (original_amount > 0),
  current_balance NUMERIC NOT NULL,
  accrued_growth NUMERIC NOT NULL DEFAULT 0,
  daily_rate NUMERIC NOT NULL DEFAULT 0.005,
  source_reference_id TEXT,
  last_growth_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','depleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pgb_user_active
  ON public.payroll_growth_balances(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_pgb_active_last_growth
  ON public.payroll_growth_balances(status, last_growth_at) WHERE status = 'active';

ALTER TABLE public.payroll_growth_balances ENABLE ROW LEVEL SECURITY;

-- Owner read
CREATE POLICY "Users view own payroll growth"
  ON public.payroll_growth_balances FOR SELECT
  USING (auth.uid() = user_id);

-- CFO / super_admin read all
CREATE POLICY "CFO and admins view all payroll growth"
  ON public.payroll_growth_balances FOR SELECT
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- Only privileged roles can write (service role bypasses RLS automatically)
CREATE POLICY "CFO and admins insert payroll growth"
  ON public.payroll_growth_balances FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE POLICY "CFO and admins update payroll growth"
  ON public.payroll_growth_balances FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- updated_at trigger
CREATE TRIGGER trg_pgb_updated_at
  BEFORE UPDATE ON public.payroll_growth_balances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- FIFO consume helper: reduces active rows oldest-first when user withdraws / is debited.
-- Returns total amount actually consumed (clamped to available).
CREATE OR REPLACE FUNCTION public.consume_payroll_growth(_user_id UUID, _amount NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  remaining NUMERIC := COALESCE(_amount, 0);
  consumed NUMERIC := 0;
  r RECORD;
  take NUMERIC;
BEGIN
  IF remaining <= 0 THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT id, current_balance
    FROM public.payroll_growth_balances
    WHERE user_id = _user_id
      AND status = 'active'
      AND current_balance > 0
    ORDER BY created_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN remaining <= 0;
    take := LEAST(r.current_balance, remaining);

    UPDATE public.payroll_growth_balances
    SET current_balance = current_balance - take,
        status = CASE
          WHEN (current_balance - take) <= 0.0001 THEN 'depleted'
          ELSE status
        END,
        updated_at = now()
    WHERE id = r.id;

    remaining := remaining - take;
    consumed := consumed + take;
  END LOOP;

  RETURN consumed;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_payroll_growth(UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_payroll_growth(UUID, NUMERIC) TO authenticated, service_role;
