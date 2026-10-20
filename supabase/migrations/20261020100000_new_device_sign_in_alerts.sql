-- New-device sign-in alerts (2026-10-20).
--
-- When an account signs in on a device it has never used, the sign-in goes
-- through, and the owner is told: by email (real addresses only) and by a
-- dialog on their already-trusted devices. They answer:
--   "I know this device"   -> status 'trusted', never asked again
--   "I don't know it"      -> status 'rejected', that device's auth session is
--                             deleted (its refresh token dies; the app on it
--                             signs itself out on its next check), and the
--                             owner gets a change-your-password tip.
-- Unanswered, the new device keeps working. A rejected device that signs in
-- again (new session) becomes 'pending' and alerts again.
--
-- Baseline: every device row that existed before this migration is 'trusted',
-- and an account's first ever device is trusted silently, so launch does not
-- flood users with alerts for devices they already use.
--
-- Only a different device that is already trusted can answer (an intruder
-- signed in as the user cannot approve their own device), and the pending list
-- is read from login_devices, which users cannot edit — unlike notifications,
-- which they can delete.
--
-- Network data (IP, city, country) is cleared after 90 days (daily cron).

ALTER TABLE public.login_devices
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'trusted',
  ADD COLUMN IF NOT EXISTS auth_session_id uuid,
  ADD COLUMN IF NOT EXISTS last_ip text,
  ADD COLUMN IF NOT EXISTS ip_city text,
  ADD COLUMN IF NOT EXISTS ip_country text,
  ADD COLUMN IF NOT EXISTS os text,
  ADD COLUMN IF NOT EXISTS browser text,
  ADD COLUMN IF NOT EXISTS device_class text,
  ADD COLUMN IF NOT EXISTS alerted_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_from_device_fp text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'login_devices_status_check') THEN
    ALTER TABLE public.login_devices
      ADD CONSTRAINT login_devices_status_check CHECK (status IN ('trusted', 'pending', 'rejected'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_login_devices_pending ON public.login_devices (user_id) WHERE status = 'pending';

-- Records a sign-in on a device. Besides the shared-device step-up decision
-- (unchanged), it now says whether the owner must be alerted about a new
-- device, and whether this device is still using a session the owner rejected.
DROP FUNCTION IF EXISTS public.register_login_device(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.register_login_device(
  p_user_id uuid,
  p_device_fp text,
  p_hw_fp text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_session_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.login_devices;
  v_had_any boolean;
  v_staff boolean;
  v_earlier integer := 0;
  v_required boolean;
BEGIN
  IF p_user_id IS NULL OR p_device_fp IS NULL
     OR NOT (p_device_fp ~ '^[a-f0-9]{64}$' OR p_device_fp ~ '^fb_[a-f0-9]{1,64}$') THEN
    RETURN jsonb_build_object('step_up_required', false, 'new_device_alert', false, 'revoked', false, 'reason', 'no_fingerprint');
  END IF;
  IF p_hw_fp IS NOT NULL AND NOT (p_hw_fp ~ '^[a-f0-9]{64}$' OR p_hw_fp ~ '^fb_[a-f0-9]{1,64}$') THEN
    p_hw_fp := NULL;
  END IF;

  v_had_any := EXISTS (SELECT 1 FROM public.login_devices WHERE user_id = p_user_id);

  INSERT INTO public.login_devices (device_fp, user_id, hw_fp, user_agent, auth_session_id, status)
  VALUES (p_device_fp, p_user_id, p_hw_fp, left(p_user_agent, 300), p_session_id,
          CASE WHEN v_had_any THEN 'pending' ELSE 'trusted' END)
  ON CONFLICT (device_fp, user_id) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.device_fp IS NULL THEN
    SELECT * INTO v_row FROM public.login_devices
     WHERE device_fp = p_device_fp AND user_id = p_user_id
     FOR UPDATE;

    IF v_row.status = 'rejected' AND p_session_id IS NOT NULL
       AND p_session_id IS DISTINCT FROM v_row.auth_session_id THEN
      -- A fresh sign-in on a device the owner rejected: ask the owner again.
      UPDATE public.login_devices
         SET status = 'pending', alerted_at = NULL, decided_at = NULL, decided_from_device_fp = NULL,
             auth_session_id = p_session_id, last_seen_at = now(), login_count = login_count + 1,
             hw_fp = COALESCE(p_hw_fp, hw_fp), user_agent = COALESCE(left(p_user_agent, 300), user_agent)
       WHERE device_fp = p_device_fp AND user_id = p_user_id
      RETURNING * INTO v_row;
    ELSE
      UPDATE public.login_devices
         SET last_seen_at = now(), login_count = login_count + 1,
             hw_fp = COALESCE(p_hw_fp, hw_fp), user_agent = COALESCE(left(p_user_agent, 300), user_agent),
             -- Keep pointing at the rejected session so the check below can still see it.
             auth_session_id = CASE WHEN status = 'rejected' THEN auth_session_id
                                    ELSE COALESCE(p_session_id, auth_session_id) END
       WHERE device_fp = p_device_fp AND user_id = p_user_id
      RETURNING * INTO v_row;
    END IF;
  END IF;

  -- Shared-device step-up (unchanged rule): 3rd+ public account on this device.
  v_staff := public.is_staff_account(p_user_id);
  SELECT count(*) INTO v_earlier
    FROM public.login_devices o
   WHERE o.device_fp = p_device_fp
     AND o.user_id <> p_user_id
     AND o.first_seen_at < v_row.first_seen_at
     AND NOT public.is_staff_account(o.user_id);
  v_required := NOT v_staff AND v_earlier >= 2 AND v_row.step_up_verified_at IS NULL;
  IF v_required AND v_row.step_up_required_at IS NULL THEN
    UPDATE public.login_devices SET step_up_required_at = now()
     WHERE device_fp = p_device_fp AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'step_up_required', v_required,
    'earlier_accounts', v_earlier,
    'verified', v_row.step_up_verified_at IS NOT NULL,
    'is_staff', v_staff,
    'device_status', v_row.status,
    'new_device_alert', v_row.status = 'pending' AND v_row.alerted_at IS NULL,
    'revoked', v_row.status = 'rejected'
  );
END
$$;
REVOKE ALL ON FUNCTION public.register_login_device(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_login_device(uuid, text, text, text, uuid) TO service_role;

-- Claims the alert for a pending device and stores what the owner will be
-- shown. Returns true only for the one caller that should send it, so a device
-- opening the app twice at once never sends two emails.
CREATE OR REPLACE FUNCTION public.claim_login_device_alert(
  p_user_id uuid, p_device_fp text,
  p_ip text DEFAULT NULL, p_city text DEFAULT NULL, p_country text DEFAULT NULL,
  p_os text DEFAULT NULL, p_browser text DEFAULT NULL, p_device_class text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.login_devices
     SET alerted_at = now(),
         last_ip = left(p_ip, 64), ip_city = left(p_city, 120), ip_country = left(p_country, 8),
         os = left(p_os, 40), browser = left(p_browser, 40), device_class = left(p_device_class, 20)
   WHERE user_id = p_user_id AND device_fp = p_device_fp
     AND status = 'pending' AND alerted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$$;
REVOKE ALL ON FUNCTION public.claim_login_device_alert(uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_login_device_alert(uuid, text, text, text, text, text, text, text) TO service_role;

-- The owner's answer, given from one of their trusted devices.
CREATE OR REPLACE FUNCTION public.decide_login_device(
  p_user_id uuid, p_from_device_fp text, p_device_fp text, p_trust boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_target public.login_devices;
  v_sessions integer := 0;
BEGIN
  IF p_user_id IS NULL OR p_device_fp IS NULL OR p_from_device_fp IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_input');
  END IF;
  IF p_from_device_fp = p_device_fp THEN
    RETURN jsonb_build_object('ok', false, 'error', 'same_device');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.login_devices
     WHERE user_id = p_user_id AND device_fp = p_from_device_fp AND status = 'trusted'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_trusted_device');
  END IF;

  SELECT * INTO v_target FROM public.login_devices
   WHERE user_id = p_user_id AND device_fp = p_device_fp
   FOR UPDATE;
  IF v_target.device_fp IS NULL OR v_target.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_pending');
  END IF;

  IF p_trust THEN
    UPDATE public.login_devices
       SET status = 'trusted', decided_at = now(), decided_from_device_fp = p_from_device_fp
     WHERE user_id = p_user_id AND device_fp = p_device_fp;
  ELSE
    UPDATE public.login_devices
       SET status = 'rejected', decided_at = now(), decided_from_device_fp = p_from_device_fp
     WHERE user_id = p_user_id AND device_fp = p_device_fp;
    -- End that device's sign-in: its refresh token dies with the session.
    IF v_target.auth_session_id IS NOT NULL THEN
      DELETE FROM auth.sessions WHERE id = v_target.auth_session_id AND user_id = p_user_id;
      GET DIAGNOSTICS v_sessions = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', CASE WHEN p_trust THEN 'trusted' ELSE 'rejected' END,
                            'sessions_ended', v_sessions);
END
$$;
REVOKE ALL ON FUNCTION public.decide_login_device(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_login_device(uuid, text, text, boolean) TO service_role;

-- Privacy: clear network data 90 days after a device was last seen.
CREATE OR REPLACE FUNCTION public.purge_login_device_network_data()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.login_devices
     SET last_ip = NULL, ip_city = NULL, ip_country = NULL
   WHERE last_seen_at < now() - interval '90 days'
     AND (last_ip IS NOT NULL OR ip_city IS NOT NULL OR ip_country IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM public.device_step_up_challenges WHERE created_at < now() - interval '90 days';
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.purge_login_device_network_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_login_device_network_data() TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-login-device-network-data';
  PERFORM cron.schedule('purge-login-device-network-data', '17 3 * * *',
                        'select public.purge_login_device_network_data()');
END
$$;
