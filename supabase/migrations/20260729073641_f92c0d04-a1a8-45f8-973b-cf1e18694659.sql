-- 1. Frequency columns
ALTER TABLE public.agent_advances
  ADD COLUMN IF NOT EXISTS repayment_frequency text NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS installment_amount numeric;

ALTER TABLE public.agent_advance_requests
  ADD COLUMN IF NOT EXISTS repayment_frequency text NOT NULL DEFAULT 'daily';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_advances_repayment_frequency_check') THEN
    ALTER TABLE public.agent_advances
      ADD CONSTRAINT agent_advances_repayment_frequency_check
      CHECK (repayment_frequency IN ('daily','weekly','biweekly','monthly'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_advance_requests_repayment_frequency_check') THEN
    ALTER TABLE public.agent_advance_requests
      ADD CONSTRAINT agent_advance_requests_repayment_frequency_check
      CHECK (repayment_frequency IN ('daily','weekly','biweekly','monthly'));
  END IF;
END $$;

-- 2. Helper: days in one repayment period
CREATE OR REPLACE FUNCTION public.advance_period_days(_frequency text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE lower(coalesce(_frequency,'daily'))
    WHEN 'weekly' THEN 7
    WHEN 'biweekly' THEN 14
    WHEN 'monthly' THEN 30
    ELSE 1
  END;
$$;

-- 3. Backfill installment_amount for existing (daily) advances
UPDATE public.agent_advances
SET installment_amount = CASE
      WHEN coalesce(cycle_days,0) > 0
        THEN ceil((coalesce(principal,0) + coalesce(access_fee,0)) / cycle_days)
      ELSE NULL END
WHERE installment_amount IS NULL;

-- 4. Privileged terms editor
CREATE OR REPLACE FUNCTION public.update_agent_advance_terms(
  p_advance_id uuid,
  p_monthly_rate numeric,
  p_cycle_days integer,
  p_repayment_frequency text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adv public.agent_advances%ROWTYPE;
  v_old_total numeric;
  v_paid numeric;
  v_new_access_fee numeric;
  v_new_total numeric;
  v_new_outstanding numeric;
  v_period integer;
  v_installments integer;
  v_installment numeric;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  ) THEN
    RAISE EXCEPTION 'Only the CFO or Agent Ops may edit advance terms';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;
  IF p_monthly_rate IS NULL OR p_monthly_rate < 0 OR p_monthly_rate > 1 THEN
    RAISE EXCEPTION 'Rate must be between 0%% and 100%% per month';
  END IF;
  IF p_cycle_days IS NULL OR p_cycle_days < 1 OR p_cycle_days > 365 THEN
    RAISE EXCEPTION 'Term must be between 1 and 365 days';
  END IF;
  IF lower(coalesce(p_repayment_frequency,'daily')) NOT IN ('daily','weekly','biweekly','monthly') THEN
    RAISE EXCEPTION 'Invalid repayment frequency';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found'; END IF;
  IF v_adv.status NOT IN ('active','overdue') THEN
    RAISE EXCEPTION 'Only active or overdue advances can be re-termed';
  END IF;

  v_old_total := coalesce(v_adv.principal,0) + coalesce(v_adv.access_fee,0);
  v_paid := greatest(0, v_old_total - coalesce(v_adv.outstanding_balance,0));

  v_new_access_fee := round(coalesce(v_adv.principal,0) * (power(1 + p_monthly_rate, p_cycle_days::numeric / 30) - 1));
  v_new_total := coalesce(v_adv.principal,0) + v_new_access_fee;
  v_new_outstanding := greatest(0, v_new_total - v_paid);

  v_period := public.advance_period_days(p_repayment_frequency);
  v_installments := greatest(1, ceil(p_cycle_days::numeric / v_period));
  v_installment := ceil(v_new_total / v_installments);

  UPDATE public.agent_advances
  SET monthly_rate = p_monthly_rate,
      daily_rate = p_monthly_rate,
      cycle_days = p_cycle_days,
      repayment_frequency = lower(p_repayment_frequency),
      access_fee = v_new_access_fee,
      installment_amount = v_installment,
      outstanding_balance = v_new_outstanding,
      expires_at = coalesce(v_adv.issued_at, now()) + (p_cycle_days || ' days')::interval,
      status = CASE WHEN v_new_outstanding <= 0 THEN 'completed' ELSE v_adv.status END,
      updated_at = now()
  WHERE id = p_advance_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (auth.uid(), 'advance_terms_edited', 'agent_advances', p_advance_id, jsonb_build_object(
    'reason', trim(p_reason),
    'old', jsonb_build_object('monthly_rate', v_adv.monthly_rate, 'cycle_days', v_adv.cycle_days,
                              'repayment_frequency', v_adv.repayment_frequency, 'access_fee', v_adv.access_fee,
                              'outstanding_balance', v_adv.outstanding_balance),
    'new', jsonb_build_object('monthly_rate', p_monthly_rate, 'cycle_days', p_cycle_days,
                              'repayment_frequency', lower(p_repayment_frequency), 'access_fee', v_new_access_fee,
                              'outstanding_balance', v_new_outstanding, 'installment_amount', v_installment)
  ));

  RETURN jsonb_build_object(
    'advance_id', p_advance_id,
    'access_fee', v_new_access_fee,
    'total_payable', v_new_total,
    'outstanding_balance', v_new_outstanding,
    'installment_amount', v_installment,
    'installments', v_installments
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_agent_advance_terms(uuid, numeric, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.advance_period_days(text) TO authenticated, anon, service_role;