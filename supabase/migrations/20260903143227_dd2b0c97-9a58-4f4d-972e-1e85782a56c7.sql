CREATE OR REPLACE FUNCTION public.cc_attempt_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_open integer;
  v_attempts integer;
  v_wip integer;
BEGIN
  SELECT r.attempts_made, c.wip_limit
    INTO v_attempts, v_wip
  FROM public.cc_cycle_rows r
  JOIN public.cc_call_cycles c ON c.id = r.cycle_id
  WHERE r.id = NEW.cycle_row_id
  FOR UPDATE OF r;

  IF v_attempts IS NULL THEN
    RAISE EXCEPTION 'Roster row % not found.', NEW.cycle_row_id;
  END IF;

  v_wip := COALESCE(v_wip, 10);

  SELECT count(*) INTO v_open
  FROM public.cc_call_attempts
  WHERE caller_id = NEW.caller_id AND recorded_at IS NULL;

  IF v_open >= v_wip THEN
    RAISE EXCEPTION
      'Record the outcome of your open calls before revealing another number. You may have % open at a time.',
      v_wip;
  END IF;

  -- No attempt cap: an officer may reveal a number as many times as needed
  -- while the row keeps its current status. Only recording an outcome moves it.
  NEW.attempt_no := v_attempts + 1;

  RETURN NEW;
END;
$function$;