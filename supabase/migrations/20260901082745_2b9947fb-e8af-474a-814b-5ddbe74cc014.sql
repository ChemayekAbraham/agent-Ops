ALTER TABLE public.crm_call_sessions
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid;

CREATE OR REPLACE FUNCTION public.crm_cancel_call(p_session_id uuid)
RETURNS text
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

  -- Flag the cancel first so the provider callback can honour it even if the
  -- row is already terminal by the time we return.
  UPDATE public.crm_call_sessions
     SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
         cancelled_by = COALESCE(cancelled_by, auth.uid()),
         status = CASE
                    WHEN status IN ('initiating','queued','ringing','ringing_staff','bridged','in_progress','active')
                      THEN 'cancelled'
                    ELSE status
                  END,
         hangup_cause = CASE
                    WHEN status IN ('initiating','queued','ringing','ringing_staff','bridged','in_progress','active')
                      THEN COALESCE(hangup_cause, 'CancelledByStaff')
                    ELSE hangup_cause
                  END,
         duration_seconds = COALESCE(duration_seconds, 0),
         updated_at = now()
   WHERE id = p_session_id
  RETURNING status INTO v_status;

  RETURN COALESCE(v_status, 'not_found');
END;
$function$;