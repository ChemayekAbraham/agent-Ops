-- 1. Guard: recognise system/process corrections even when a human session is present.
CREATE OR REPLACE FUNCTION public.guard_agent_landlord_float_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_process text := btrim(COALESCE(NEW.performed_by_process, ''));
BEGIN
  -- Automated corrections (allocation-sync triggers, cron reconciliation) carry no
  -- human author. They must name their process, and are never role-gated: the
  -- signed-in user did not ask for them, a trigger did.
  IF NEW.performed_by IS NULL THEN
    IF v_process = '' THEN
      RAISE EXCEPTION 'FLOAT_CORRECTION_PROCESS_REQUIRED: a system correction must name the process that made it'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'FLOAT_CORRECTION_AUTHOR_MISMATCH: the correction must be recorded under the signed-in author'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
    public.has_role(NEW.performed_by, 'cfo')
    OR public.has_role(NEW.performed_by, 'financial_ops')
    OR public.has_role(NEW.performed_by, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'FLOAT_CORRECTION_NOT_AUTHORIZED: only the CFO, Financial Ops or a super admin can correct agent float'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.performed_by = NEW.agent_id THEN
    RAISE EXCEPTION 'FLOAT_CORRECTION_SELF_BLOCKED: you cannot correct your own float'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.reason IS NULL OR length(btrim(NEW.reason)) < 20 THEN
    RAISE EXCEPTION 'FLOAT_CORRECTION_EVIDENCE_REQUIRED: written evidence of at least 20 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

-- 2. Automated recompute must not attribute itself to the signed-in user.
CREATE OR REPLACE FUNCTION public.recompute_agent_landlord_float(
  p_agent_id uuid,
  p_reason text DEFAULT 'allocation_sync',
  p_performed_by uuid DEFAULT NULL,
  p_process text DEFAULT 'trigger',
  p_allow_increase boolean DEFAULT true,
  p_apply boolean DEFAULT true
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_correct numeric := 0;
  v_prev numeric;
  v_exists boolean;
  v_apply boolean;
  v_process text := COALESCE(NULLIF(btrim(COALESCE(p_process, '')), ''), 'trigger');
  v_author uuid;
BEGIN
  IF p_agent_id IS NULL THEN RETURN NULL; END IF;

  -- Automated paths are system corrections: no human author, process named.
  IF v_process IN ('trigger', 'cron', 'allocation_sync', 'system') THEN
    v_author := p_performed_by;  -- NULL unless a caller explicitly owns it
  ELSE
    v_author := COALESCE(p_performed_by, auth.uid());
  END IF;

  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_correct
  FROM public.agent_landlord_float_allocations
  WHERE agent_id = p_agent_id
    AND status IN ('open', 'partially_paid', 'return_pending');

  SELECT balance, true INTO v_prev, v_exists
  FROM public.agent_landlord_float WHERE agent_id = p_agent_id;

  IF NOT COALESCE(v_exists, false) THEN
    IF v_correct > 0 AND p_apply THEN
      INSERT INTO public.agent_landlord_float (agent_id, balance, total_funded, total_paid_out)
      VALUES (p_agent_id, v_correct, v_correct, 0)
      ON CONFLICT (agent_id) DO NOTHING;
    END IF;
    RETURN v_correct;
  END IF;

  IF v_prev = v_correct THEN RETURN v_correct; END IF;

  v_apply := p_apply AND (p_allow_increase OR v_correct < v_prev);

  IF v_apply THEN
    UPDATE public.agent_landlord_float
    SET balance = v_correct, updated_at = now()
    WHERE agent_id = p_agent_id;
  END IF;

  INSERT INTO public.agent_landlord_float_corrections (
    agent_id, previous_balance, corrected_balance, difference,
    open_allocation_total, reason, performed_by, performed_by_process, applied
  ) VALUES (
    p_agent_id, v_prev, CASE WHEN v_apply THEN v_correct ELSE v_prev END,
    v_correct - v_prev, v_correct, p_reason,
    v_author, v_process, v_apply
  );

  RETURN CASE WHEN v_apply THEN v_correct ELSE v_prev END;
END;
$$;