CREATE OR REPLACE FUNCTION public.sync_landlord_float_from_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM public.recompute_agent_landlord_float(
      NEW.agent_id, 'allocation_' || lower(TG_OP), NULL, 'allocation_trigger', true, true);
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.agent_id IS DISTINCT FROM COALESCE(NEW.agent_id, '00000000-0000-0000-0000-000000000000'::uuid) THEN
    PERFORM public.recompute_agent_landlord_float(
      OLD.agent_id, 'allocation_' || lower(TG_OP), NULL, 'allocation_trigger', true, true);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_agent_landlord_float(p_agent_id uuid, p_reason text DEFAULT 'allocation_sync'::text, p_performed_by uuid DEFAULT NULL::uuid, p_process text DEFAULT 'trigger'::text, p_allow_increase boolean DEFAULT true, p_apply boolean DEFAULT true)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF v_process IN ('trigger', 'cron', 'allocation_sync', 'allocation_trigger', 'system', 'reconcile', 'reconciliation') THEN
    v_author := NULL;
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
$function$;