-- Calling spine: an officer is no longer blocked from opening another call
-- because they hold open (pending-feedback) calls. Feedback is still required
-- to move a roster row; only the blocking condition is removed. Everything else
-- in this trigger (roster row lock, existence check, attempt numbering) is kept
-- byte-for-byte.
CREATE OR REPLACE FUNCTION public.cc_attempt_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attempts integer;
BEGIN
  SELECT r.attempts_made
    INTO v_attempts
  FROM public.cc_cycle_rows r
  JOIN public.cc_call_cycles c ON c.id = r.cycle_id
  WHERE r.id = NEW.cycle_row_id
  FOR UPDATE OF r;

  IF v_attempts IS NULL THEN
    RAISE EXCEPTION 'Roster row % not found.', NEW.cycle_row_id;
  END IF;

  -- No open-attempt (work-in-progress) cap: holding calls with pending feedback
  -- must never stop an officer opening the next tenant. Recording the outcome is
  -- still the only thing that moves a row's status.
  -- No attempt cap either: an officer may reveal a number as many times as needed
  -- while the row keeps its current status.
  NEW.attempt_no := v_attempts + 1;

  RETURN NEW;
END;
$function$;