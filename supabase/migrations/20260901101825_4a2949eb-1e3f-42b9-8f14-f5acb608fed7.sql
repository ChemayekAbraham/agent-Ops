CREATE OR REPLACE FUNCTION public.crm_finalize_call_from_client(p_session_id uuid, p_hangup_cause text DEFAULT NULL::text, p_duration integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.crm_call_sessions;
  v_cause text := UPPER(NULLIF(TRIM(COALESCE(p_hangup_cause, '')), ''));
  v_status text;
  v_ended_by text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT * INTO v_row
    FROM public.crm_call_sessions
   WHERE id = p_session_id AND staff_id = v_uid
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'call_not_found';
  END IF;

  v_ended_by := CASE
    WHEN v_row.cancel_requested_at IS NOT NULL
         AND v_row.cancel_requested_at > now() - interval '60 seconds' THEN 'crm_user'
    WHEN v_cause IN ('CALL_REJECTED','USER_BUSY','NO_ANSWER','NO_USER_RESPONSE','SUBSCRIBER_ABSENT')
      THEN 'remote_party'
    WHEN v_cause IN ('SERVICE_UNAVAILABLE','USER_NOT_REGISTERED','UNALLOCATED_NUMBER',
                     'NORMAL_TEMPORARY_FAILURE','RECOVERY_ON_TIMER_EXPIRE')
      THEN 'network'
    ELSE 'unknown'
  END;

  -- Already finalised by the webhook (or a duplicate event): never rewrite the
  -- outcome, but do backfill the reason/side when the provider gave none.
  IF v_row.ended_at IS NOT NULL THEN
    IF v_cause IS NOT NULL AND v_row.hangup_cause IS NULL THEN
      UPDATE public.crm_call_sessions
         SET hangup_cause = v_cause,
             ended_by = CASE WHEN COALESCE(ended_by, 'unknown') = 'unknown'
                             THEN v_ended_by ELSE ended_by END
       WHERE id = p_session_id;
    END IF;
    RETURN jsonb_build_object('finalized', false, 'status', v_row.status,
                              'cause_backfilled', v_cause IS NOT NULL AND v_row.hangup_cause IS NULL);
  END IF;

  v_status := CASE v_cause
    WHEN 'CALL_REJECTED' THEN 'rejected'
    WHEN 'USER_BUSY' THEN 'busy'
    WHEN 'NO_ANSWER' THEN 'not_answered'
    WHEN 'NO_USER_RESPONSE' THEN 'not_answered'
    WHEN 'SUBSCRIBER_ABSENT' THEN 'not_answered'
    WHEN 'ORIGINATOR_CANCEL' THEN 'cancelled'
    WHEN 'SERVICE_UNAVAILABLE' THEN 'failed'
    WHEN 'USER_NOT_REGISTERED' THEN 'failed'
    WHEN 'UNALLOCATED_NUMBER' THEN 'failed'
    WHEN 'NORMAL_TEMPORARY_FAILURE' THEN 'failed'
    WHEN 'RECOVERY_ON_TIMER_EXPIRE' THEN 'failed'
    ELSE CASE WHEN v_row.answered_at IS NOT NULL THEN 'completed' ELSE 'not_answered' END
  END;

  UPDATE public.crm_call_sessions
     SET status = v_status,
         hangup_cause = COALESCE(v_cause, hangup_cause),
         is_active = false,
         ended_at = now(),
         ended_by = v_ended_by,
         duration_seconds = COALESCE(
           NULLIF(GREATEST(COALESCE(p_duration, 0), 0), 0),
           duration_seconds,
           0
         )
   WHERE id = p_session_id;

  RETURN jsonb_build_object('finalized', true, 'status', v_status, 'ended_by', v_ended_by);
END;
$function$;