CREATE OR REPLACE FUNCTION public.crm_record_call_outcome(p_session_id uuid, p_outcome text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF p_outcome NOT IN ('rejected', 'not_reachable') THEN
    RAISE EXCEPTION 'unsupported_outcome';
  END IF;

  -- Only a live leg may be overridden by a human. A terminal provider callback
  -- that already landed is authoritative and is never overwritten.
  UPDATE public.crm_call_sessions
     SET status = CASE WHEN p_outcome = 'rejected' THEN 'rejected' ELSE 'no-answer' END,
         hangup_cause = CASE WHEN p_outcome = 'rejected' THEN 'CallRejected' ELSE 'NotReachable' END,
         duration_seconds = COALESCE(duration_seconds, 0),
         failure_reason = 'staff_override',
         updated_at = now()
   WHERE id = p_session_id
     AND status IN ('initiating', 'queued', 'ringing', 'ringing_staff', 'bridged', 'in_progress', 'active')
  RETURNING status INTO v_status;

  IF v_status IS NULL THEN
    -- Already settled (or not visible) — nothing to override, and that is fine.
    RETURN;
  END IF;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.crm_record_call_outcome(uuid, text) FROM anon;