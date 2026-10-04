-- 1. Request-level top-up fields
ALTER TABLE public.agent_advance_requests
  ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS parent_advance_id uuid REFERENCES public.agent_advances(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS extend_days integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_advance_requests_request_kind_check'
  ) THEN
    ALTER TABLE public.agent_advance_requests
      ADD CONSTRAINT agent_advance_requests_request_kind_check
      CHECK (request_kind IN ('new','topup'));
  END IF;
END $$;

-- 2. Top-up audit row extras
ALTER TABLE public.agent_advance_topups
  ADD COLUMN IF NOT EXISTS extend_days integer,
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS access_fee_added numeric NOT NULL DEFAULT 0;

-- 3. Eligibility helper
CREATE OR REPLACE FUNCTION public.agent_advance_topup_eligibility(p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a public.agent_advances;
  v_total numeric;
  v_repaid numeric;
  v_pct numeric;
  v_expected numeric;
  v_behind boolean;
  v_pipeline boolean;
  v_reason text := null;
  v_max numeric := 0;
BEGIN
  SELECT * INTO a
  FROM public.agent_advances
  WHERE agent_id = p_agent_id
    AND status IN ('active','overdue')
    AND outstanding_balance > 0
  ORDER BY issued_at DESC
  LIMIT 1;

  IF a.id IS NULL THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'has_active_advance', false,
      'reason', 'No ongoing advance to top up.'
    );
  END IF;

  v_total := COALESCE(a.principal,0) + COALESCE(a.access_fee,0) + COALESCE(a.registration_fee,0);
  v_repaid := GREATEST(0, v_total - COALESCE(a.outstanding_balance,0));
  v_pct := CASE WHEN v_total > 0 THEN round((v_repaid / v_total) * 100, 2) ELSE 0 END;

  v_expected := public.advance_expected_repaid_to_date(
    a.issued_at,
    a.principal,
    COALESCE(a.access_fee,0) + COALESCE(a.registration_fee,0),
    a.cycle_days,
    a.repayment_frequency,
    a.installment_amount
  );
  v_behind := (v_repaid + 1) < COALESCE(v_expected, 0)
              OR COALESCE(a.arrears_balance,0) > 0
              OR a.status = 'overdue';

  v_pipeline := EXISTS (
    SELECT 1 FROM public.agent_advance_requests
    WHERE agent_id = p_agent_id
      AND status IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved')
  );

  v_max := floor(COALESCE(a.principal,0) * 0.90);

  IF v_pipeline THEN
    v_reason := 'You already have an advance request in the approval pipeline.';
  ELSIF v_behind THEN
    v_reason := 'You are behind on your current repayment schedule. Catch up before requesting a top-up.';
  ELSIF v_pct < 30 THEN
    v_reason := 'You must repay at least 30% of the current advance before a top-up. Currently at '
                || v_pct::text || '%.';
  ELSIF v_max < 10000 THEN
    v_reason := 'Your current advance is too small for a top-up (minimum top-up is UGX 10,000).';
  END IF;

  RETURN jsonb_build_object(
    'eligible', v_reason IS NULL,
    'reason', v_reason,
    'has_active_advance', true,
    'advance_id', a.id,
    'principal', a.principal,
    'access_fee', a.access_fee,
    'registration_fee', a.registration_fee,
    'total_payable', v_total,
    'outstanding_balance', a.outstanding_balance,
    'repaid_amount', v_repaid,
    'repaid_percent', v_pct,
    'expected_repaid_to_date', v_expected,
    'behind', v_behind,
    'status', a.status,
    'monthly_rate', a.monthly_rate,
    'repayment_frequency', a.repayment_frequency,
    'installment_amount', a.installment_amount,
    'cycle_days', a.cycle_days,
    'issued_at', a.issued_at,
    'expires_at', a.expires_at,
    'max_topup', v_max,
    'min_topup', 10000
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_advance_topup_eligibility(uuid) TO authenticated, service_role;

-- 4. Allow top-up requests past the no-double-advance guard
CREATE OR REPLACE FUNCTION public.enforce_no_double_agent_advance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_elig jsonb;
BEGIN
  IF NEW.status NOT IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved') THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.request_kind,'new') = 'topup' THEN
    IF TG_OP = 'INSERT' THEN
      v_elig := public.agent_advance_topup_eligibility(NEW.agent_id);
      IF NOT (v_elig->>'eligible')::boolean THEN
        RAISE EXCEPTION 'Top-up not allowed: %', COALESCE(v_elig->>'reason','not eligible')
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.parent_advance_id IS NULL THEN
        NEW.parent_advance_id := (v_elig->>'advance_id')::uuid;
      ELSIF NEW.parent_advance_id <> (v_elig->>'advance_id')::uuid THEN
        RAISE EXCEPTION 'Top-up must target the current ongoing advance.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF COALESCE(NEW.extend_days,0) <= 0 THEN
        RAISE EXCEPTION 'Top-up requires the number of days to extend the schedule by.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.principal < (v_elig->>'min_topup')::numeric
         OR NEW.principal > (v_elig->>'max_topup')::numeric THEN
        RAISE EXCEPTION 'Top-up amount must be between UGX % and UGX % (90%% of the current advance).',
          (v_elig->>'min_topup'), (v_elig->>'max_topup')
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_advances
    WHERE agent_id = NEW.agent_id
      AND status IN ('active','overdue')
      AND outstanding_balance > 0
  ) THEN
    RAISE EXCEPTION 'Agent already has an ongoing advance with an outstanding balance. Request a top-up instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM public.agent_advance_requests
    WHERE agent_id = NEW.agent_id
      AND id <> NEW.id
      AND status IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved')
  ) THEN
    RAISE EXCEPTION 'Agent already has a pending advance request in the approval pipeline.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- 5. Merge an approved top-up into the existing advance
CREATE OR REPLACE FUNCTION public.apply_advance_topup(
  p_advance_id uuid,
  p_amount numeric,
  p_extend_days integer,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a public.agent_advances;
  v_elig jsonb;
  v_fee numeric;
  v_new_principal numeric;
  v_new_access_fee numeric;
  v_new_outstanding numeric;
  v_new_cycle integer;
  v_new_expires timestamptz;
  v_period integer;
  v_remaining_installments integer;
  v_installment numeric;
  v_days_elapsed integer;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'super_admin') OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised to apply advance top-ups.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO a FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'Advance not found.';
  END IF;

  v_elig := public.agent_advance_topup_eligibility(a.agent_id);
  IF NOT (v_elig->>'eligible')::boolean THEN
    RAISE EXCEPTION 'Top-up rejected: %', COALESCE(v_elig->>'reason','not eligible');
  END IF;
  IF (v_elig->>'advance_id')::uuid <> a.id THEN
    RAISE EXCEPTION 'Top-up target is not the agent''s current ongoing advance.';
  END IF;
  IF p_amount < (v_elig->>'min_topup')::numeric OR p_amount > (v_elig->>'max_topup')::numeric THEN
    RAISE EXCEPTION 'Top-up amount must be between UGX % and UGX %.',
      (v_elig->>'min_topup'), (v_elig->>'max_topup');
  END IF;
  IF COALESCE(p_extend_days,0) <= 0 THEN
    RAISE EXCEPTION 'Extension days must be greater than zero.';
  END IF;

  -- Access fee on the top-up only, at the inherited rate over the extension window
  v_fee := round(p_amount * (power(1 + COALESCE(a.monthly_rate, 0.33), p_extend_days::numeric / 30) - 1));

  v_new_principal   := COALESCE(a.principal,0) + p_amount;
  v_new_access_fee  := COALESCE(a.access_fee,0) + v_fee;
  v_new_outstanding := COALESCE(a.outstanding_balance,0) + p_amount + v_fee;
  v_new_cycle       := COALESCE(a.cycle_days,30) + p_extend_days;
  v_new_expires     := GREATEST(a.expires_at, now()) + make_interval(days => p_extend_days);

  v_period := public.advance_period_days(a.repayment_frequency);
  v_days_elapsed := GREATEST(0, ((now() AT TIME ZONE 'Africa/Kampala')::date
                                 - (a.issued_at AT TIME ZONE 'Africa/Kampala')::date));
  -- Remaining installments across the extended schedule
  v_remaining_installments := GREATEST(
    1,
    ceil(GREATEST(1, v_new_cycle - v_days_elapsed)::numeric / v_period)
  );
  v_installment := ceil(v_new_outstanding / v_remaining_installments);

  UPDATE public.agent_advances
  SET principal = v_new_principal,
      access_fee = v_new_access_fee,
      outstanding_balance = v_new_outstanding,
      cycle_days = v_new_cycle,
      expires_at = v_new_expires,
      installment_amount = v_installment,
      daily_installment = CASE WHEN a.repayment_frequency = 'daily' THEN v_installment ELSE a.daily_installment END,
      status = 'active',
      updated_at = now()
  WHERE id = a.id;

  INSERT INTO public.agent_advance_topups (advance_id, amount, topped_up_by, extend_days, request_id, access_fee_added)
  VALUES (a.id, p_amount, COALESCE(auth.uid(), a.issued_by), p_extend_days, p_request_id, v_fee);

  RETURN jsonb_build_object(
    'advance_id', a.id,
    'agent_id', a.agent_id,
    'topup_amount', p_amount,
    'access_fee_added', v_fee,
    'new_principal', v_new_principal,
    'new_outstanding', v_new_outstanding,
    'new_cycle_days', v_new_cycle,
    'new_expires_at', v_new_expires,
    'new_installment', v_installment,
    'repayment_frequency', a.repayment_frequency,
    'monthly_rate', a.monthly_rate
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_advance_topup(uuid, numeric, integer, uuid) TO authenticated, service_role;