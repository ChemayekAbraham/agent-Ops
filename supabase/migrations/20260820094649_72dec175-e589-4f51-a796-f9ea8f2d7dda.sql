CREATE OR REPLACE FUNCTION public.reconcile_agent_landlord_float_all(p_apply boolean DEFAULT false, p_allow_increase boolean DEFAULT false, p_reason text DEFAULT 'scheduled_scan'::text, p_process text DEFAULT 'cron'::text)
 RETURNS TABLE(agent_id uuid, agent_name text, previous_balance numeric, correct_balance numeric, difference numeric, applied boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_apply boolean;
  v_process text := COALESCE(NULLIF(btrim(COALESCE(p_process,'')),''), 'cron');
  v_author uuid;
BEGIN
  IF v_process IN ('trigger','cron','allocation_sync','allocation_trigger','system','reconcile','reconciliation') THEN
    v_author := NULL;
  ELSE
    v_author := auth.uid();
  END IF;

  FOR r IN
    SELECT f.agent_id AS aid,
           f.balance AS prev,
           COALESCE((
             SELECT SUM(a.remaining_amount)
             FROM public.agent_landlord_float_allocations a
             WHERE a.agent_id = f.agent_id
               AND a.status IN ('open','partially_paid','return_pending')
           ), 0) AS correct
    FROM public.agent_landlord_float f
  LOOP
    IF r.prev = r.correct THEN CONTINUE; END IF;
    v_apply := p_apply AND (p_allow_increase OR r.correct < r.prev);

    IF v_apply THEN
      UPDATE public.agent_landlord_float
      SET balance = r.correct, updated_at = now()
      WHERE agent_landlord_float.agent_id = r.aid;
    END IF;

    INSERT INTO public.agent_landlord_float_corrections (
      agent_id, previous_balance, corrected_balance, difference,
      open_allocation_total, reason, performed_by, performed_by_process, applied
    ) VALUES (
      r.aid, r.prev, CASE WHEN v_apply THEN r.correct ELSE r.prev END,
      r.correct - r.prev, r.correct, p_reason, v_author, v_process, v_apply
    );

    agent_id := r.aid;
    SELECT p.full_name INTO agent_name FROM public.profiles p WHERE p.id = r.aid;
    previous_balance := r.prev;
    correct_balance := r.correct;
    difference := r.correct - r.prev;
    applied := v_apply;
    RETURN NEXT;
  END LOOP;
END;
$function$;