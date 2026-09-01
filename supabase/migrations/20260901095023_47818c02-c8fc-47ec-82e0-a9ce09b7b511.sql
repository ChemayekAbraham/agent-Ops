-- ---------------------------------------------------------------------------
-- CRM voice: browser (WebRTC) call lifecycle on the EXISTING telephony table.
-- No new call table: crm_call_sessions stays the single source of truth.
-- ---------------------------------------------------------------------------

ALTER TABLE public.crm_call_sessions
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'pstn',
  ADD COLUMN IF NOT EXISTS at_client_name text,
  ADD COLUMN IF NOT EXISTS is_active boolean,
  ADD COLUMN IF NOT EXISTS answered_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_by text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crm_call_sessions_transport_ck'
  ) THEN
    ALTER TABLE public.crm_call_sessions
      ADD CONSTRAINT crm_call_sessions_transport_ck
      CHECK (transport IN ('pstn', 'webrtc'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crm_call_sessions_ended_by_ck'
  ) THEN
    ALTER TABLE public.crm_call_sessions
      ADD CONSTRAINT crm_call_sessions_ended_by_ck
      CHECK (ended_by IS NULL OR ended_by IN ('crm_user', 'remote_party', 'network', 'unknown'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS crm_call_sessions_webrtc_match_idx
  ON public.crm_call_sessions (transport, target_phone, created_at DESC);

-- ---------------------------------------------------------------------------
-- Start a browser call: creates the row and reveals the E.164 number the
-- browser client must dial. Reveal is already a sanctioned CRM action
-- (crm_reveal_target_phone) — the browser cannot dial a masked number.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_start_webrtc_call(
  p_target_user_id uuid,
  p_target_name text,
  p_target_role text,
  p_target_location text,
  p_client_name text,
  p_target_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_raw text;
  v_digits text;
  v_e164 text;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF public.crm_call_centre_authorized(v_uid) IS NOT TRUE THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_raw := COALESCE(
    (SELECT phone FROM public.profiles WHERE id = p_target_user_id),
    p_target_phone
  );

  v_digits := regexp_replace(COALESCE(v_raw, ''), '\D', '', 'g');
  v_e164 := CASE
    WHEN v_digits ~ '^256[3-9][0-9]{8}$' THEN '+' || v_digits
    WHEN v_digits ~ '^0[3-9][0-9]{8}$'   THEN '+256' || substr(v_digits, 2)
    WHEN v_digits ~ '^[3-9][0-9]{8}$'    THEN '+256' || v_digits
    ELSE NULL
  END;

  IF v_e164 IS NULL THEN
    RAISE EXCEPTION 'invalid_target_phone';
  END IF;

  INSERT INTO public.crm_call_sessions (
    staff_id, target_user_id, target_role, target_name, target_phone,
    target_location, direction, status, transport, at_client_name, is_active
  ) VALUES (
    v_uid, p_target_user_id, COALESCE(p_target_role, 'tenant'),
    LEFT(COALESCE(p_target_name, ''), 160), v_e164,
    LEFT(p_target_location, 160), 'Outbound', 'initiating', 'webrtc',
    LEFT(NULLIF(TRIM(p_client_name), ''), 120), true
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('session_id', v_id, 'target_phone', v_e164);
END;
$$;

-- ---------------------------------------------------------------------------
-- Answered (browser 'callaccepted'). Never moves a call that already ended.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_mark_call_answered(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  UPDATE public.crm_call_sessions
     SET answered_at = COALESCE(answered_at, now()),
         status = 'active',
         is_active = true
   WHERE id = p_session_id
     AND staff_id = v_uid
     AND ended_at IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Finalise from the browser 'hangup' event. IDEMPOTENT: the first terminal
-- signal wins, whether it came from here or from the provider webhook.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_finalize_call_from_client(
  p_session_id uuid,
  p_hangup_cause text DEFAULT NULL,
  p_duration integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Already finalised by the webhook (or a duplicate event): do nothing.
  IF v_row.ended_at IS NOT NULL THEN
    RETURN jsonb_build_object('finalized', false, 'status', v_row.status);
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

  -- Only claim a side when there is real evidence.
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
$$;

REVOKE ALL ON FUNCTION public.crm_start_webrtc_call(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_mark_call_answered(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_finalize_call_from_client(uuid, text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.crm_start_webrtc_call(uuid, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crm_mark_call_answered(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crm_finalize_call_from_client(uuid, text, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: the calling screen must learn about a remote hangup instantly.
-- ---------------------------------------------------------------------------
ALTER TABLE public.crm_call_sessions REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'crm_call_sessions'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.crm_call_sessions;
  END IF;
END $$;
