
-- 1. Expand status check to allow 'cancelled'
ALTER TABLE public.agent_advances DROP CONSTRAINT IF EXISTS agent_advances_status_check;
ALTER TABLE public.agent_advances ADD CONSTRAINT agent_advances_status_check
  CHECK (status = ANY (ARRAY['active','completed','overdue','cancelled']));

-- 2. Cancellation metadata columns
ALTER TABLE public.agent_advances
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_mode TEXT
    CHECK (cancellation_mode IS NULL OR cancellation_mode IN ('write_off','recoup_from_wallet')),
  ADD COLUMN IF NOT EXISTS pre_cancel_outstanding NUMERIC;

-- 3. Cancel RPC — restricted to CFO or Manager
CREATE OR REPLACE FUNCTION public.cancel_agent_advance(
  p_advance_id UUID,
  p_recoup BOOLEAN,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_adv RECORD;
  v_mode TEXT;
  v_prev_outstanding NUMERIC;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (public.has_role(v_caller, 'cfo'::app_role)
       OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can cancel advances';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A cancellation reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance not found';
  END IF;

  IF v_adv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Advance already cancelled';
  END IF;
  IF v_adv.status = 'completed' THEN
    RAISE EXCEPTION 'Advance already completed';
  END IF;

  v_mode := CASE WHEN p_recoup THEN 'recoup_from_wallet' ELSE 'write_off' END;
  v_prev_outstanding := v_adv.outstanding_balance;

  IF p_recoup THEN
    -- Keep outstanding intact; CFO will record wallet recovery via existing
    -- "Record Payment" flow. Deductions still stop because status != active.
    UPDATE public.agent_advances SET
      status = 'cancelled',
      daily_installment = 0,
      cancelled_at = now(),
      cancelled_by = v_caller,
      cancellation_reason = p_reason,
      cancellation_mode = v_mode,
      pre_cancel_outstanding = v_prev_outstanding,
      updated_at = now()
    WHERE id = p_advance_id;
  ELSE
    -- Full write-off
    UPDATE public.agent_advances SET
      status = 'cancelled',
      outstanding_balance = 0,
      arrears_balance = 0,
      daily_installment = 0,
      cancelled_at = now(),
      cancelled_by = v_caller,
      cancellation_reason = p_reason,
      cancellation_mode = v_mode,
      pre_cancel_outstanding = v_prev_outstanding,
      updated_at = now()
    WHERE id = p_advance_id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_caller,
    'agent_advance_cancelled',
    'agent_advances',
    p_advance_id,
    jsonb_build_object(
      'mode', v_mode,
      'reason', p_reason,
      'previous_outstanding', v_prev_outstanding,
      'agent_id', v_adv.agent_id,
      'principal', v_adv.principal
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'mode', v_mode,
    'previous_outstanding', v_prev_outstanding,
    'new_outstanding', CASE WHEN p_recoup THEN v_prev_outstanding ELSE 0 END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_agent_advance(UUID, BOOLEAN, TEXT) TO authenticated;
